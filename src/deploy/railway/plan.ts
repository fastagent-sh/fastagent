/**
 * `fastagent deploy railway` — the Railway deploy PLAN, computed from the resolved definition. Pure:
 * facts in, artifact contents + an ordered runbook out; the CLI writes the files and prints the runbook.
 *
 * Railway is the second target, and it is NOT a copy of Fly — three asymmetries drive this module:
 *
 *  1. The config file is thin. `railway.json` (config-as-code) holds ONLY build/deploy settings; the
 *     volume, the variables (state root + secrets), and App Sleeping are Railway service settings applied
 *     by CLI/dashboard, not the file. So Fly's "one committed file is the single source" does not carry:
 *     Railway's source of truth is the linked project's platform state, not a file we generate.
 *
 *  2. Scale-to-zero is not scriptable. Railway's App Sleeping is a dashboard-only toggle (no CLI/API),
 *     so unlike Fly's `auto_stop_machines`, we cannot generate it — the runbook states the manual step.
 *     This is a real capability downgrade vs Fly, named rather than hidden.
 *
 *  3. The public URL is minted, not deterministic. Fly gives `<app>.fly.dev` up front; Railway mints a
 *     `*.up.railway.app` domain that must be read back (`railway domain`), so the webhook step points at
 *     "the domain from `railway domain`" rather than a precomputed URL.
 *
 * What IS shared with Fly comes from the neutral modules: the container (Dockerfile + .dockerignore) and
 * the required-secret list. `railway.json`'s `healthcheckPath=/health` also fixes the "routed before the
 * server is listening" boot race Fly's deploy hit — Railway only routes once /health passes.
 */
import type { DeclaredChannel } from "../../channels/discover.ts";
import { webhookRunbook } from "../channel-ingress.ts";
import { type Artifact, type ContainerInput, containerArtifacts } from "../container.ts";
import { deploymentSecrets, isEnvKey } from "../secrets.ts";

export interface RailwayPlanInput extends ContainerInput {
  // No `port`: Railway injects PORT and the container CMD/railway.json never name one (unlike Fly's
  // internal_port) — the server binds $PORT at runtime. Nothing here would use it.
  /** The service name to create (`railway add --service`). Railway service names are project-scoped, not
   *  globally unique (unlike a Fly app), so the CLI derives it from the dir basename — any value works. */
  serviceName: string;
  /** What satisfies model auth locally: an env-var name, an OAuth/stored label, or undefined. */
  modelAuth: string | undefined;
  /** Every declared channel and its ingress — the source of the secret list, the webhook steps, and
   *  whether App Sleeping must stay off for an outbound connection. */
  channels: readonly DeclaredChannel[];
  // Container facts (hasPackageJson, runtime, hasLockfile, bunVersion, version, apt) come from
  // ContainerInput — ONE source, so the plan and the generated Dockerfile can't drift.
  /** Extra secret env-var names (fastagent.config deploy.secrets) — added to the runbook's secret list. */
  extraSecrets?: string[];
  /** Time triggers present (schedules/ or selfSchedule) — the runbook forbids App Sleeping: cron/wake has
   *  no external wake-up, so a sleeping service sleeps through them. Required (like FlyPlanInput's) so a
   *  caller can't silently omit it and degrade the sleeping guidance to "optional". */
  hasTimeTriggers: boolean;
}

export interface RailwayPlan {
  /** railway.json / Dockerfile / .dockerignore — written by the CLI (skipped if present unless --force). */
  artifacts: Artifact[];
  /** The ordered, values-resolved deploy runbook — printed to stdout for the coding agent to execute. */
  runbook: string[];
}

/** State root = the volume mount path, kept in lockstep. `/data` matches the Fly recipe. */
const MOUNT = "/data";

/** The `RAILWAY_DOCKERFILE_PATH` value for an agent under `prefix` — repo-root-anchored with a leading
 *  slash, the form Railway's builds/dockerfiles docs use for a Dockerfile in another directory. The
 *  config file's `dockerfilePath` spells it WITHOUT the slash (the config-as-code schema's own
 *  convention); two mechanisms, two documented spellings, one fact each. */
export const dockerfilePathVar = (prefix: string): string => `/${prefix}Dockerfile`;

/** railway.json — build/deploy only (Railway's config-as-code scope). No env/volume/sleeping here: those
 *  are service settings the runbook applies via CLI. healthcheckPath gates routing on a live server. */
/** railway.json is JSON, so its ownership marker is a KEY rather than a comment line. Railway ignores
 *  unknown keys; the predicate below is what lets `--force` reset OUR file and keep a hand-written one. */
const GENERATED_RAILWAY_KEY = "x-generated-by";
const GENERATED_RAILWAY_VALUE = "fastagent deploy railway";

/** Did fastagent generate this `railway.json`? Unparseable or unmarked reads as the author's. */
export function isGeneratedRailwayJson(content: string): boolean {
  try {
    return (JSON.parse(content) as Record<string, unknown>)[GENERATED_RAILWAY_KEY] === GENERATED_RAILWAY_VALUE;
  } catch {
    return false;
  }
}

function railwayJson(prefix: string): string {
  return `${JSON.stringify(
    {
      $schema: "https://railway.com/railway.schema.json",
      [GENERATED_RAILWAY_KEY]: GENERATED_RAILWAY_VALUE,
      // dockerfilePath is relative to the workspace root (`railway up`'s upload context).
      build: { builder: "DOCKERFILE", dockerfilePath: `${prefix}Dockerfile` },
      deploy: { healthcheckPath: "/health", restartPolicyType: "ON_FAILURE" },
    },
    null,
    2,
  )}\n`;
}

/** Compute the Railway deploy plan from the resolved definition. */
export function planRailwayDeploy(input: RailwayPlanInput): RailwayPlan {
  const { serviceName, modelAuth, channels } = input;
  // railway.json is namespaced under the agent dir too (the workspace may carry its own
  // railway.toml/json for the product). Railway reads config-as-code from the repo root by default and
  // pointing it at a custom path is DASHBOARD-ONLY — so the BUILD entry travels as the scriptable
  // RAILWAY_DOCKERFILE_PATH service variable instead (Railway's documented non-root-Dockerfile route),
  // and the config-as-code pointer degrades to an OPTIONAL enhancement: the /health gate (Railway's
  // default restart policy already matches the file's ON_FAILURE).
  const configPath = `${input.agentPrefix}railway.json`;
  const artifacts: Artifact[] = [
    { path: configPath, content: railwayJson(input.agentPrefix) },
    ...containerArtifacts(input),
  ];

  const secrets = deploymentSecrets(modelAuth, channels, input.extraSecrets);
  const requiredSecrets = secrets.filter((secret) => secret.required);
  const optionalSecrets = secrets.filter((secret) => !secret.required);

  // Order matters, not cosmetics: `railway init` creates a PROJECT with no service, but the volume and
  // variables are service-scoped and `railway up` deploys THE service — so the service must exist first
  // (`railway add --service`), and variables must be set BEFORE the first `up` or the box boots without a
  // model key / FASTAGENT_STATE_DIR and crash-loops against restartPolicy ON_FAILURE + the healthcheck.
  const runbook: string[] = [
    `# Deploy to Railway. ${configPath} / Dockerfile(.dockerignore) are generated above.`,
    `# Prereqs: the Railway CLI (https://docs.railway.com/guides/cli) and \`railway login\`.`,
    ``,
    `# One-time setup (init → service → volume → variables). SKIP all of it on a redeploy — a redeploy is`,
    `# just \`railway up\` (below). Re-running these makes a second project, a DUPLICATE service (Railway`,
    `# service names are project-scoped, NOT unique — no error), and another volume, splitting state.`,
    ``,
    `# Create + link a project (writes .railway link state in this dir; the project — not a committed`,
    `# file — is Railway's source of truth for identity, variables, and the volume).`,
    `railway init            # or \`railway link\` to attach an existing project`,
    ``,
    `# Create the service. \`railway init\` makes only a project; the volume/variables below are`,
    `# service-scoped and \`railway up\` deploys THIS service. \`add\` auto-links it to this directory, so`,
    `# the later commands resolve it without --service (--run passes --service to stay non-interactive).`,
    `railway add --service ${serviceName}`,
    ``,
    `# Persistent volume at ${MOUNT} — .state (sessions, channel state) + .secrets (seeded auth).`,
    `railway volume add --mount-path ${MOUNT}`,
    ``,
    `# Variables — set BEFORE the first deploy so the box boots with them. Railway injects PORT itself.`,
    `# RAILWAY_DOCKERFILE_PATH points the build at the agent's Dockerfile — a service variable,`,
    `# Railway's documented route to a non-root Dockerfile (no dashboard step needed for the build).`,
    `railway variables set FASTAGENT_STATE_DIR=${MOUNT}/.state FASTAGENT_SECRETS_DIR=${MOUNT}/.secrets RAILWAY_DOCKERFILE_PATH=${dockerfilePathVar(input.agentPrefix)}`,
  ];

  if (requiredSecrets.length > 0) {
    runbook.push(
      `# Required secrets:`,
      `#   ${requiredSecrets.map((s) => `${s.name}: ${s.hint}`).join("\n#   ")}`,
      `railway variables set ${requiredSecrets.map((s) => `${s.name}=<value>`).join(" ")}`,
    );
  }
  if (optionalSecrets.length > 0) {
    runbook.push(
      `# Optional secrets — set only when the matching feature is configured:`,
      `#   ${optionalSecrets.map((s) => `${s.name}: ${s.hint}`).join("\n#   ")}`,
      `# railway variables set ${optionalSecrets.map((s) => `${s.name}=<value>`).join(" ")}`,
    );
  }

  // Model-auth guidance: an env key becomes a variable above. Otherwise the plan can't read the local
  // credential's value (OAuth or a stored key) to set it — same wording discipline as the Fly plan.
  if (!isEnvKey(modelAuth)) {
    runbook.push(
      modelAuth === undefined
        ? `# Model auth: none found at the local auth path — a global \`fastagent login\` isn't read here; pass --auth-path <file> (e.g. ~/.fastagent/.secrets/auth.json), or \`--run\` carries it automatically.`
        : `# Model auth: your local auth is "${modelAuth}" — the plan can't read its value to set as a variable.`,
      `#   Set your provider API key as a variable (railway variables set KEY=...), OR place auth.json on the ${MOUNT} volume.`,
    );
  }

  runbook.push(
    ``,
    `# OPTIONAL — the build already uses the agent's Dockerfile via RAILWAY_DOCKERFILE_PATH (set above),`,
    `# and Railway's default restart policy equals what ${configPath} declares (ON_FAILURE).`,
    `# Pointing the service at ${configPath} (Service → Settings → Config-as-code — dashboard-only) adds`,
    `# the /health healthcheck gate: a boot-crashing deploy is marked FAILED instead of going live dead.`,
    `# (Zero-downtime switching doesn't apply either way — the ${MOUNT} volume allows one active deployment.)`,
  );
  runbook.push(
    ``,
    `# Deploy — uploads this dir and builds the Dockerfile on Railway (no local Docker needed). This is`,
    `# also the ENTIRE redeploy: re-run \`railway up\` alone (the one-time setup above is not repeated).`,
    `railway up`,
  );
  if (input.shipsGit) {
    runbook.push(
      ``,
      `# The image is a WYSIWYG snapshot of this directory. Freshness/durability run through git, driven`,
      `# by the agent itself (pull to freshen, commit/push to write back; creds ride config.deploy.secrets;`,
      `# git is baked into the image). CAVEAT — \`railway up\` is known to strip .git from its upload:`,
      `# expect NO baked history on the box; the agent should \`git clone\` its repo in the workspace`,
      `# (same token) before making changes.`,
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

  // The public URL is minted, not deterministic (unlike Fly's <app>.fly.dev) — ONE mint step, then each
  // channel's webhook uses that domain (mint once even when both channels are present).
  // Mint only when something below needs it: with nothing to point at the domain (no channels, or only
  // long-connection ones), "use it in the step(s) below" would refer to steps that do not follow.
  const steps = webhookRunbook(`https://<your-domain>`, channels);
  if (steps.length > 0) {
    runbook.push(
      ``,
      `# Public URL — Railway mints a *.up.railway.app domain (NOT deterministic). Generate it, then read`,
      `# the printed https URL and use it as <your-domain> in the webhook step(s) below:`,
      `railway domain`,
      ...steps,
    );
  }

  // Scale-to-zero: App Sleeping is dashboard-only (no CLI/API) — a manual step, not a generated setting.
  // A github channel should NOT enable it: fire-and-forget reviews have no replay (unlike Telegram's L1
  // turn store), so a sleep mid-review would drop it — the same floor the Fly plan enforces via config.
  runbook.push(
    ``,
    channels.some((channel) => channel.name === "github")
      ? `# Scale-to-zero: do NOT enable App Sleeping — github turns have no replay, a sleep mid-review is lost.`
      : input.hasTimeTriggers
        ? `# Scale-to-zero: do NOT enable App Sleeping — schedules/wake-ups have no external wake-up; a sleeping service sleeps through them.`
        : channels.some((channel) => channel.ingress === "long-connection")
          ? `# Scale-to-zero: do NOT enable App Sleeping — a long-connection channel must remain connected.`
          : `# Scale-to-zero (optional, dashboard-only — no CLI/API): Settings → Deploy → Serverless → App Sleeping.`,
    `# Keep this a SINGLE service: the ${MOUNT} volume is tied to one service; extra replicas split state.`,
  );

  return { artifacts, runbook };
}
