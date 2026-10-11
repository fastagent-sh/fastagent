/** `fastagent deploy railway` — the Railway deploy PLAN, computed from the resolved definition. */
import type { DeclaredChannel } from "../../channels/discover.ts";
import { webhookRunbook } from "../channel-ingress.ts";
import { type Artifact, type ContainerInput, containerArtifacts, imageHasGit } from "../container.ts";
import { deploymentLoginCommand } from "../box-shell.ts";
import { WAKEUPS_WHEN_ASLEEP, residencyFor } from "../residency.ts";
import type { DeploymentSecret } from "../secrets.ts";

export interface RailwayPlanInput extends ContainerInput {
  // No `port`: Railway injects PORT and the container CMD never names one (unlike Fly's internal_port) — the server
  // binds $PORT at runtime.
  /** The service name to create (`railway add --service`). */
  serviceName: string;
  /**
   * The provider the deployment logs in to itself (`fastagent login --deployment`): its credential is not a variable
   * the plan carries.
   */
  boxLogin?: string;
  /**
   * Every declared channel and its ingress — the source of the secret list, the webhook steps, and whether App
   * Sleeping must stay off for an outbound connection.
   */
  channels: readonly DeclaredChannel[];
  // Container facts (hasPackageJson, runtime, hasLockfile, bunVersion, version, apt) come from ContainerInput.
  /**
   * The runbook's variable list (`deploymentSecrets`): what must have a value, then everything else the value file
   * carries.
   */
  secrets?: readonly DeploymentSecret[];
  /** `schedules/` declares a schedule — one of the things that forbids App Sleeping (deploy/residency.ts). */
  hasCron: boolean;
}

export interface RailwayPlan {
  /**
   * Dockerfile / .dockerignore — written by the CLI (skipped if present unless --force). No Railway config file: Railway
   * builds from a root `Dockerfile` and restarts on failure by default, and the `/health` check that `railway.json`
   * carried is the `--run` driver's own public probe now (Railway retires `railway.json`, and its replacement,
   * `.railway/railway.ts`, would make every agent install Railway's SDK).
   */
  artifacts: Artifact[];
  /** The ordered, values-resolved deploy runbook — printed to stdout for the coding agent to execute. */
  runbook: string[];
}

/** State root = the volume mount path, kept in lockstep. */
const MOUNT = "/data";

/** The name this tool gives BOTH the project and the service, derived from the agent directory's name. */
export function toRailwayName(basename: string): string {
  return basename.replace(/[^a-zA-Z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
}

/** Compute the Railway deploy plan from the resolved definition. */
export function planRailwayDeploy(input: RailwayPlanInput): RailwayPlan {
  const { serviceName, channels } = input;
  const artifacts: Artifact[] = containerArtifacts(input);

  const secrets = input.secrets ?? [];

  // Order matters, not cosmetics: `railway init` creates a PROJECT with no service, but the volume and variables are
  // service-scoped and `railway up` deploys THE service.
  const runbook: string[] = [
    `# Deploy to Railway. Dockerfile(.dockerignore) are generated above.`,
    `# Prereqs: the Railway CLI (https://docs.railway.com/guides/cli) and \`railway login\`.`,
    ``,
    `# One-time setup (init → service → volume → variables). Skip it on redeploy: repeating it creates`,
    `# another project/service/volume, splitting the agent's state.`,
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
    `# Persistent volume at ${MOUNT} — .state (sessions, channel state) + .secrets (the box's own login).`,
    `railway volume add --mount-path ${MOUNT}`,
    ``,
    `# Variables — set BEFORE the first deploy so the box boots with them. Railway injects PORT itself.`,
    `railway variables set FASTAGENT_STATE_DIR=${MOUNT}/.state FASTAGENT_SECRETS_DIR=${MOUNT}/.secrets`,
  ];

  if (secrets.length > 0) {
    runbook.push(
      `# Secrets:`,
      `#   ${secrets.map((s) => `${s.name}: ${s.hint}`).join("\n#   ")}`,
      `railway variables set ${secrets.map((s) => `${s.name}=<value>`).join(" ")}`,
    );
  }

  runbook.push(
    ``,
    `# Before a new definition release, run \`fastagent deploy railway\` to refresh the release manifest.`,
    `# Upload the agent directory and build on Railway (no local Docker needed): Railway builds the`,
    `# Dockerfile at its root. It marks the deploy live once the container starts, without waiting for`,
    `# /health: \`railway logs\` shows a box that crashes on boot.`,
    `railway up`,
  );
  // The credential is created on the box, never carried: the box is then the only holder of its grant.
  if (input.boxLogin) {
    runbook.push(
      ``,
      `# Model auth: once it is up, the deployment logs in to ${input.boxLogin} itself (from the agent directory):`,
      `${deploymentLoginCommand("railway", input.boxLogin)}`,
    );
  }
  runbook.push(
    ``,
    `# The volume keeps .state and .secrets across restarts and deploys; each release replaces /data/definition.`,
    input.shipsGit
      ? `# Railway uploads may strip .git, so the deployed definition may have no history.`
      : imageHasGit(input)
        ? `# Git is installed (github content is cloned here, or mise.toml declares it).`
        : `# To give the agent git, declare it: fastagent env bootstrap packages use apt:git`,
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

  // Scale-to-zero: App Sleeping is dashboard-only (no CLI/API) — a manual step, not a generated setting. WHY it is
  // forbidden is residency.ts's to decide; the SETTING and the path through the dashboard are Railway's.
  const residency = residencyFor({ channels, hasCron: input.hasCron });
  runbook.push(
    ``,
    residency
      ? `# Scale-to-zero: do NOT enable App Sleeping — ${residency.why}.`
      : `# Scale-to-zero (optional, dashboard-only — no CLI/API): Settings → Deploy → Serverless → App Sleeping —\n# ${WAKEUPS_WHEN_ASLEEP}.`,
    `# Keep this a SINGLE service: the ${MOUNT} volume is tied to one service; extra replicas split state.`,
  );

  return { artifacts, runbook };
}
