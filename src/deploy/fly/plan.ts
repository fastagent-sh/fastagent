/**
 * `fastagent deploy fly` — the Fly.io deploy PLAN, computed from the resolved definition. Pure: facts
 * in, artifact contents + an ordered runbook out; the CLI (deploy side effects live there) writes the
 * files and prints the runbook.
 *
 * fastagent owns the two ends only it can know — generate definition-aware artifacts (state root →
 * volume, autostop tuned to the turn model, the exact secret list) and the post-deploy webhook step —
 * and GUIDES the middle (flyctl app/volume/secrets/deploy) as a precise, values-resolved runbook. By
 * default a coding agent (or you) runs flyctl from that runbook; `deploy fly --run` drives it from the
 * CLI instead. This module stays pure either way — it produces the plan, never runs flyctl. The runbook
 * is a FIRST-deploy sequence: `apps`/`volumes create` are one-time (marked so — re-running would make a
 * second volume, the state split it warns against); a redeploy is `fly deploy` alone.
 *
 * autostop = "suspend": the machine snapshots and suspends when idle (Fly Proxy sees inbound load 0),
 * resumes on the next webhook in ~hundreds of ms. A long turn interrupted by an idle-suspend whose
 * snapshot is discarded replays on the next start (the Telegram L1 turn store) — at-least-once, the
 * documented floor. State on the /data volume survives stop/suspend on the same machine.
 */
import type { ChannelKind } from "../../scaffold/add-channel.ts";
import { type Artifact, type ContainerInput, containerArtifacts } from "../container.ts";
import { deploymentSecrets, isEnvKey } from "../secrets.ts";

export interface FlyPlanInput extends ContainerInput {
  // Container facts (hasPackageJson, runtime, hasLockfile, bunVersion, version, apt) come from
  // ContainerInput — ONE source, so the plan and the generated Dockerfile can't drift.
  /** Fly app name — globally unique, lowercase; the CLI sanitizes it from the dir basename. */
  appName: string;
  /** The port the app listens on (config.http.port ?? 8787); fly.toml routes to it. */
  port: number;
  /**
   * What satisfies model auth locally ({@link probeAuthSource}): an env-var name (`OPENAI_API_KEY`),
   * `"OAuth"`/`"stored credential"` (a local login the server can't use), or undefined (unconfigured).
   */
  modelAuth: string | undefined;
  /** Known first-party channels — each contributes its secret metadata + webhook step. */
  channels: ChannelKind[];
  /** All long-connection channel basenames, including custom channels — require one running machine. */
  longConnectionChannels?: string[];
  /** Extra secret env-var names (fastagent.config deploy.secrets) — added to the runbook's secret list. */
  extraSecrets?: string[];
  /** `auto_stop_machines` — `"suspend"` (default, fast resume) or `"stop"` (cold start). CLI `--stop`. */
  autostop: "suspend" | "stop";
  /** Allow scaling to zero when idle (default true → `min_machines_running=0`). CLI `--no-scale-to-zero`
   *  forces one machine up; a github channel forces it too (fire-and-forget turns have no replay). */
  scaleToZero: boolean;
  /** Time triggers present (schedules/ or selfSchedule) — forces one machine up: cron/wake has no
   *  external wake-up, so a scaled-to-zero box would sleep through them. */
  hasTimeTriggers: boolean;
}

export interface FlyPlan {
  /** fly.toml / Dockerfile / .dockerignore — written by the CLI (skipped if present unless --force). */
  artifacts: Artifact[];
  /** The ordered, values-resolved deploy runbook — printed to stdout for the coding agent to execute. */
  runbook: string[];
}

function flyToml(
  appName: string,
  port: number,
  hasGithub: boolean,
  autostop: "suspend" | "stop",
  scaleToZero: boolean,
  hasTimeTriggers: boolean,
  hasLongConnectionChannel: boolean,
): string {
  // min_machines_running: 1 (keep one up) when a github channel is present, TIME triggers exist, OR the
  // operator opted out of scale-to-zero. GitHub's is a SAFETY default — its fire-and-forget turns have no
  // replay, so scaling to zero could drop an in-flight review. Time triggers (schedules/wake) have no
  // external wake-up at all — a scaled-to-zero box sleeps through the cron instant. Reason-tagged so the
  // comment is honest.
  const min = hasGithub
    ? `  min_machines_running = 1         # github turns have no replay — don't scale to zero (an in-flight review would be lost)`
    : hasTimeTriggers
      ? `  min_machines_running = 1         # schedules/wake-ups need a running machine (no external wake-up for a cron instant)`
      : hasLongConnectionChannel
        ? `  min_machines_running = 1         # long-connection channel needs a running machine (cannot wake from zero)`
        : !scaleToZero
          ? `  min_machines_running = 1         # kept running (--no-scale-to-zero)`
          : `  min_machines_running = 0         # scale to zero`;
  const stopLine =
    autostop === "stop"
      ? `  auto_stop_machines = "stop"      # stop on idle (cold start on the next webhook)`
      : `  auto_stop_machines = "suspend"   # suspend on idle (fast resume on the next webhook)`;
  return `# Generated by \`fastagent deploy fly\`. Edit freely — it is not regenerated unless you pass --force.
app = "${appName}"
primary_region = "iad"  # set your region (list: \`fly platform regions\`)

[build]

[env]
  FASTAGENT_STATE_DIR = "/data/.state"      # mutable machine state — sessions, channel state, schedule
  FASTAGENT_SECRETS_DIR = "/data/.secrets"  # seeded (and rotated) credentials — must persist across restarts
  PORT = "${port}"

[http_service]
  internal_port = ${port}
  force_https = true
${stopLine}
  auto_start_machines = true
${min}

[mounts]
  source = "data"
  destination = "/data"            # .state + .secrets — persists across stop/suspend/redeploy

[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"                 # suspend is not recommended above 2 GB
`;
}

/** Compute the Fly deploy plan from the resolved definition. */
export function planFlyDeploy(input: FlyPlanInput): FlyPlan {
  const { appName, port, modelAuth, channels, standalone } = input;
  // Standalone: every artifact is namespaced under the workspace (.fastagent/fly.toml,
  // .fastagent/Dockerfile) so the host repo's own deploy files are never touched; the runbook passes
  // explicit -c/--dockerfile flags (unambiguous across flyctl versions — no reliance on
  // config-relative path resolution).
  const flyTomlPath = standalone ? ".fastagent/fly.toml" : "fly.toml";
  const artifacts: Artifact[] = [
    {
      path: flyTomlPath,
      content: flyToml(
        appName,
        port,
        channels.includes("github"),
        input.autostop,
        input.scaleToZero,
        input.hasTimeTriggers,
        (input.longConnectionChannels?.length ?? 0) > 0,
      ),
    },
    ...containerArtifacts(input),
  ];

  // The exact secret list the deployed machine needs, computed from the definition (host-neutral): the
  // model key (when local auth is an env key) + every discovered channel's secrets. Names + hints as
  // COMMENT lines (a `#` inside a `\`-continued command would break the shell), then one flat, executable
  // `fly secrets set` the coding agent fills — `<value>` placeholders, never inline comments.
  const secrets = deploymentSecrets(modelAuth, channels, input.extraSecrets, input.longConnectionChannels);
  const requiredSecrets = secrets.filter((secret) => secret.required);
  const optionalSecrets = secrets.filter((secret) => !secret.required);

  const deployCmd = standalone
    ? `fly deploy . --config .fastagent/fly.toml --dockerfile .fastagent/Dockerfile --app ${appName}`
    : `fly deploy --app ${appName}`;
  const runbook: string[] = [
    `# Deploy "${appName}" to Fly.io. ${flyTomlPath} / Dockerfile(.dockerignore) are generated above.`,
    `# Prereqs: flyctl installed (https://fly.io/docs/flyctl/install) and \`fly auth login\`.`,
    ``,
    `# One-time setup (skip on a redeploy — a second run makes a SECOND app/volume, splitting state).`,
    `# Fly app names are GLOBALLY unique: if this fails as taken, set a unique "app" in fly.toml and`,
    `# re-run \`fastagent deploy fly\` — the runbook follows fly.toml's app name.`,
    `fly apps create ${appName}`,
    `# volume persists /data/.state (sessions, channel state) + /data/.secrets (seeded auth) across stop/suspend/redeploy.`,
    `# <region> MUST equal primary_region in fly.toml (a volume in another region can't mount) — fly.toml`,
    `# is the single source for the region; skip this if the volume exists (fly volumes list --app ${appName}):`,
    `fly volumes create data --app ${appName} --region <region> --size 1`,
  ];

  if (requiredSecrets.length > 0) {
    runbook.push(
      ``,
      `# Required secrets (replace each <value>):`,
      ...requiredSecrets.map((s) => `#   ${s.name}: ${s.hint}`),
      `fly secrets set --app ${appName} ${requiredSecrets.map((s) => `${s.name}=<value>`).join(" ")}`,
    );
  }
  if (optionalSecrets.length > 0) {
    runbook.push(
      ``,
      `# Optional secrets — set only when the matching feature is configured:`,
      ...optionalSecrets.map((s) => `#   ${s.name}: ${s.hint}`),
      `# fly secrets set --app ${appName} ${optionalSecrets.map((s) => `${s.name}=<value>`).join(" ")}`,
    );
  }
  if (standalone) {
    runbook.push(
      ``,
      `# Standalone workspace: the build context is the WORKBENCH ROOT (the whole directory is baked as`,
      `# the agent's cwd); the config/Dockerfile live under .fastagent/ so they never collide with the`,
      `# host repo's own deploy files. Run this from the workbench root:`,
    );
  }
  runbook.push(deployCmd);
  if (input.shipsGit) {
    runbook.push(
      ``,
      `# The image is a WYSIWYG snapshot of this directory. Freshness/durability run through git, driven`,
      `# by the agent itself: .git ships in the image (see .dockerignore) and git is baked in, so the agent`,
      `# can pull to freshen content and commit/push its work back (creds ride config.deploy.secrets; the`,
      `# POLICY — push vs PR, identity — lives in persona.md). CAVEAT: whether .git survives the upload is`,
      `# host-CLI-dependent — verify \`git status\` on the box; if missing, have the agent clone instead.`,
      `# Un-pushed changes on the box never survive a redeploy; durability lives in git.`,
    );
  } else {
    runbook.push(
      ``,
      `# The image is a WYSIWYG snapshot of this directory. No .git here, so no history ships and the`,
      `# generated image does not install git — changes on the box are ephemeral and never survive a`,
      `# redeploy. If the agent should clone/push repos as part of its work, add deploy: { apt: ["git"] }.`,
    );
  }

  // Model-auth guidance: an env key becomes a secret above. Otherwise the plan can't read the local
  // credential's VALUE to set as a secret — true for OAuth AND a stored API key (both are
  // `AuthResult.source` non-env labels), so the wording doesn't prejudge whether it's migratable.
  if (!isEnvKey(modelAuth)) {
    runbook.push(
      ``,
      modelAuth === undefined
        ? `# Model auth: none found at the local auth path — a global \`fastagent login\` isn't read here; pass --auth-path <file> (e.g. ~/.fastagent/auth.json), or \`--run\` carries it automatically.`
        : `# Model auth: your local auth is "${modelAuth}" — the plan can't read its value to set as a secret.`,
      `#   Set your provider API key as a Fly secret (fly secrets set KEY=...), OR place auth.json at /data/.secrets/ on the volume.`,
    );
  }

  // The fastagent-only post-step: point each channel's webhook at the live URL. Only fastagent knows the routes.
  // The URLs below assume each channel's DEFAULT route key (POST /telegram, POST /webhook). Reading the
  // real key would mean executing the channel factory (getMe, state-dir creation) — wrong at plan time
  // — so the runbook states the assumption instead of silently printing a stale path for remapped glue.
  const post: string[] = [];
  if (channels.includes("telegram")) {
    post.push(
      `# After deploy — register the Telegram webhook. The path assumes the default route (POST /telegram);`,
      `# if you remapped it in channels/telegram.ts, use your path. secret_token MUST equal TELEGRAM_SECRET_TOKEN:`,
      `curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \\`,
      `  -d url=https://${appName}.fly.dev/telegram -d secret_token=<TELEGRAM_SECRET_TOKEN>`,
    );
  }
  if (channels.includes("github")) {
    post.push(
      `# After deploy — set the GitHub webhook (repo Settings → Webhooks). Path assumes the default route`,
      `# (POST /webhook); if you remapped it in channels/github.ts, use your path:`,
      `#   Payload URL = https://${appName}.fly.dev/webhook, content type application/json, secret = GITHUB_WEBHOOK_SECRET`,
    );
  }
  if (channels.includes("slack")) {
    post.push(
      `# After deploy — set Slack Event Subscriptions → Request URL. Path assumes POST /slack;`,
      `# Slack verifies the running endpoint with a challenge:`,
      `#   Request URL = https://${appName}.fly.dev/slack`,
      `# Ensure OAuth scopes + message.* subscriptions match the groupBehavior in channels/slack.ts.`,
    );
  }
  for (const kind of ["feishu", "lark"] as const) {
    if (!channels.includes(kind) || input.longConnectionChannels?.includes(kind)) continue;
    const label = kind === "feishu" ? "Feishu" : "Lark";
    post.push(
      `# After deploy — set the ${label} event Request URL (developer console → Events & Callbacks).`,
      `# Path assumes the default route (POST /${kind}); the app must be RUNNING when you save (the console`,
      `# verifies the URL with a challenge):`,
      `#   Request URL = https://${appName}.fly.dev/${kind}`,
    );
  }
  if (post.length > 0) runbook.push(``, ...post);

  // Single-machine tier: state lives on ONE volume tied to ONE machine. Scaling to multiple machines
  // splits state (each gets its own volume) — that needs a shared/external backend, not this recipe.
  runbook.push(
    ``,
    `# Keep this a SINGLE machine: the /data volume (and all state on it) is tied to one machine.`,
    `# Multiple machines would each get their own volume and split sessions/turns — don't scale past 1.`,
  );

  return { artifacts, runbook };
}

/**
 * The `app` name from an existing fly.toml's `app = "…"` line, or undefined if absent — the KEEP-mode
 * single source (a user who renamed the app is not overridden by the basename guess). Accepts TOML's
 * double OR single quotes; anything else (or no `app`) is undefined → the caller falls back to basename.
 */
export function parseFlyAppName(toml: string): string | undefined {
  return toml.match(/^\s*app\s*=\s*["']([^"']+)["']/m)?.[1];
}

/** The `primary_region` from a fly.toml, or undefined — `--run` passes it to `fly volumes create` so the
 *  volume lands in the machine's region (fly.toml is the single source; see {@link parseFlyAppName}). */
export function parseFlyRegion(toml: string): string | undefined {
  return toml.match(/^\s*primary_region\s*=\s*["']([^"']+)["']/m)?.[1];
}

/** The `min_machines_running` from a fly.toml, or undefined — the KEEP-mode check reads it so a kept
 *  file that still scales to zero can be warned about when time triggers (schedules/wake) exist. */
export function parseFlyMinMachines(toml: string): number | undefined {
  const m = toml.match(/^\s*min_machines_running\s*=\s*(\d+)/m)?.[1];
  return m === undefined ? undefined : Number(m);
}

/** Sanitize a directory basename into a Fly app name: lowercase, [a-z0-9-], must start with a letter. */
export function toFlyAppName(basename: string): string {
  const slug = basename
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return /^[a-z]/.test(slug) ? slug : `app-${slug || "agent"}`;
}
