/** `fastagent deploy railway` — the Railway deploy PLAN, computed from the resolved definition. */
import type { DeclaredChannel } from "../../channels/discover.ts";
import { webhookRunbook } from "../channel-ingress.ts";
import { type Artifact, type ContainerInput, containerArtifacts } from "../container.ts";
import { deploymentSecrets, isEnvKey } from "../secrets.ts";
import type { DeclaredSecret } from "../../declared-secrets.ts";

export interface RailwayPlanInput extends ContainerInput {
  // No `port`: Railway injects PORT and the container CMD/railway.json never name one (unlike Fly's internal_port) —
  // the server binds $PORT at runtime.
  /** The service name to create (`railway add --service`). */
  serviceName: string;
  /** What satisfies model auth locally: an env-var name, an OAuth/stored label, or undefined. */
  modelAuth: string | undefined;
  /**
   * Every declared channel and its ingress — the source of the secret list, the webhook steps, and whether App
   * Sleeping must stay off for an outbound connection.
   */
  channels: readonly DeclaredChannel[];
  // Container facts (hasPackageJson, runtime, hasLockfile, bunVersion, version, apt) come from ContainerInput.
  /** Everything the definition declared it needs (deploy.secrets + tool/schedule/channel declarations),
   *  attributed to the file that declared it. */
  extraSecrets?: readonly DeclaredSecret[];
  /**
   * Time triggers present (schedules/ or selfSchedule) — the runbook forbids App Sleeping: cron/wake has no external
   * wake-up, so a sleeping service sleeps through them.
   */
  hasTimeTriggers: boolean;
}

export interface RailwayPlan {
  /** railway.json / Dockerfile / .dockerignore — written by the CLI (skipped if present unless --force). */
  artifacts: Artifact[];
  /** The ordered, values-resolved deploy runbook — printed to stdout for the coding agent to execute. */
  runbook: string[];
}

/** State root = the volume mount path, kept in lockstep. */
const MOUNT = "/data";

/** The `RAILWAY_DOCKERFILE_PATH` value for an agent under `prefix`. */
export const dockerfilePathVar = (prefix: string): string => `/${prefix}Dockerfile`;

/** The name this tool gives BOTH the project and the service, derived from the workspace directory. */
export function toRailwayName(basename: string): string {
  return basename.replace(/[^a-zA-Z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
}

/** railway.json is JSON, so its ownership marker is a KEY rather than a comment line. */
const GENERATED_RAILWAY_KEY = "x-generated-by";
const GENERATED_RAILWAY_VALUE = "fastagent deploy railway";

export function isGeneratedRailwayJson(content: string): boolean {
  try {
    return (JSON.parse(content) as Record<string, unknown>)[GENERATED_RAILWAY_KEY] === GENERATED_RAILWAY_VALUE;
  } catch {
    return false;
  }
}

/** railway.json — build/deploy only (Railway's config-as-code scope). */
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
  // railway.json is namespaced under the agent dir too (the workspace may carry its own railway.toml/json for the
  // product).
  const configPath = `${input.agentPrefix}railway.json`;
  const artifacts: Artifact[] = [
    { path: configPath, content: railwayJson(input.agentPrefix) },
    ...containerArtifacts(input),
  ];

  const secrets = deploymentSecrets(modelAuth, channels, input.extraSecrets);
  const requiredSecrets = secrets.filter((secret) => secret.required);
  const optionalSecrets = secrets.filter((secret) => !secret.required);

  // Order matters, not cosmetics: `railway init` creates a PROJECT with no service, but the volume and variables are
  // service-scoped and `railway up` deploys THE service.
  const runbook: string[] = [
    `# Deploy to Railway. ${configPath} / Dockerfile(.dockerignore) are generated above.`,
    `# Prereqs: the Railway CLI (https://docs.railway.com/guides/cli) and \`railway login\`.`,
    ``,
    `# One-time setup (init → service → volume → variables). Skip it on redeploy: repeating it creates`,
    `# another project/service/volume, splitting the persistent workspace.`,
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

  // Model-auth guidance: an env key becomes a variable above.
  if (!isEnvKey(modelAuth)) {
    runbook.push(
      modelAuth === undefined
        ? `# Model auth: none found at the local auth path — a global \`fastagent login\` isn't read here; set FASTAGENT_AUTH_PATH (e.g. ~/.fastagent/.secrets/auth.json), or \`--run\` carries it automatically.`
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
    `# Before a new definition release, run \`fastagent deploy railway\` to refresh the release manifest.`,
    `# Upload this workspace and build on Railway (no local Docker needed):`,
    `railway up`,
  );
  runbook.push(
    ``,
    `# The volume keeps /data/base (including uncommitted work), .state and .secrets across restarts and deploys.`,
    `# Each generated release replaces only /data/base/${input.agentPrefix}; other workspace files are initialized once.`,
    input.shipsGit
      ? `# Railway uploads may strip .git. Clone inside the persistent workspace when collaboration needs history.`
      : `# To use Git for collaboration, add deploy: { apt: ["git"] }. Storage durability does not require Git.`,
  );

  // The public URL is minted, not deterministic (unlike Fly's <app>.fly.dev).
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
