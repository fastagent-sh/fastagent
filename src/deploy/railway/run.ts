/** `fastagent deploy railway --run` — drive the Railway CLI to completion. */
import { type PublicHealthProbe, type Registrars, publicHealthGate, registerWebhooks } from "../channel-ingress.ts";
import type { DeclaredChannel } from "../../channels/discover.ts";
import type { CliRunner } from "../runner.ts";
import { missingValuesGate } from "../secrets.ts";

export interface RailwayRunPlan {
  /** Names both the project (`railway init --name`) and the service (`railway add --service`). */
  name: string;
  /**
   * The volume mount path; `FASTAGENT_STATE_DIR`/`FASTAGENT_SECRETS_DIR` are set to `.state`/`.secrets` under it (kept
   * in lockstep).
   */
  mountPath: string;
  /** `KEY=value` secrets set one-per-`variable set --stdin`: the value file's variables. */
  secrets: Record<string, string>;
  /** Declared names the value file supplies no value for — the run gates on these before any side effect. */
  missingSecrets: string[];
  /** That value file, workspace-relative, so the gate names the file this deploy actually read. */
  valueFile: string;
  /** Every declared channel and its ingress — the driver asks which of them have a webhook. */
  channels: readonly DeclaredChannel[];
  /** Opt-in (CLI `--into-linked`) to provision INTO the project this directory is already linked to. */
  intoLinked: boolean;
  /** `RAILWAY_DOCKERFILE_PATH` value (`/fastagent/Dockerfile`). */
  dockerfilePath: string;
  /**
   * Log the box in (`fastagent login --deployment`) once it is up and before any entrance opens: a channel pointed at
   * a box with no model credential answers every message with a failure. Resolves a gate line, or undefined.
   */
  boxLogin?: () => Promise<string | undefined>;
}

/**
 * Done (with the live URL), or a gate the operator must clear before re-running (printed + non-zero exit by the CLI).
 */
export type RailwayRunOutcome = { ok: true; url: string } | { ok: false; gate: string };

/** Whether `railway status --json` shows a linked project: non-empty stdout. */
export function isLinked(stdout: string): boolean {
  return stdout.trim() !== "";
}

/**
 * The linked project's name for the gate message, or undefined if it can't be read (still linked — `railway status
 * --json` puts `name` at the top level on 5.15.0).
 */
export function linkedName(stdout: string): string | undefined {
  try {
    const v = JSON.parse(stdout) as { name?: unknown };
    if (typeof v.name === "string") return v.name;
  } catch {
    // non-JSON but non-empty → still linked, just no name to show
  }
  return undefined;
}

/** Every string leaf of a parsed JSON value. */
function jsonStrings(stdout: string): string[] {
  const walk = (v: unknown): string[] =>
    typeof v === "string"
      ? [v]
      : Array.isArray(v)
        ? v.flatMap(walk)
        : v && typeof v === "object"
          ? Object.values(v).flatMap(walk)
          : [];
  try {
    return walk(JSON.parse(stdout));
  } catch {
    return [];
  }
}

/** The first Railway-provided domain as an https URL, or undefined if none is present. */
export function parseDomainUrl(stdout: string): string | undefined {
  for (const s of jsonStrings(stdout)) {
    const host = s.match(/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.railway\.app/i)?.[0];
    if (host) return `https://${host}`;
  }
  return undefined;
}

/**
 * The status of the volume `railway volume list --json` shows mounted at `mountPath` ON `service`, or undefined when
 * that service has none there. The list is the whole PROJECT's: another service's volume, or one a deleted service
 * left behind (`serviceName: null` — deleting a service keeps its volume), sits at the same path and is not this
 * one. Read from any object carrying `mountPath` and `serviceName`, so a wrapper key moving does not matter.
 */
export function volumeOn(stdout: string, service: string, mountPath: string): string | undefined {
  const walk = (v: unknown): string | undefined => {
    if (Array.isArray(v)) return v.map(walk).find((status) => status !== undefined);
    if (!v || typeof v !== "object") return undefined;
    const o = v as Record<string, unknown>;
    if (o.mountPath === mountPath && o.serviceName === service) return typeof o.status === "string" ? o.status : "";
    return walk(Object.values(o));
  };
  try {
    return walk(JSON.parse(stdout));
  } catch {
    return undefined;
  }
}

/**
 * How long `--run` waits for a new volume to reach its service before deploying. Railway's `volume add` returns
 * before the volume is attached, and a deployment started in that window runs WITHOUT it — no `/data` at all —
 * while a later one gets it (measured 2026-09-27: listed on the service as `Ready` 5s after the add).
 */
const VOLUME_ATTACH_TIMEOUT_MS = 60_000;
const VOLUME_POLL_MS = 2_000;

export async function deployRailwayRun(
  plan: RailwayRunPlan,
  railway: CliRunner,
  log: (msg: string) => void,
  registrars: Registrars,
  healthProbe?: PublicHealthProbe,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<RailwayRunOutcome> {
  const gate = (g: string): RailwayRunOutcome => ({ ok: false, gate: g });
  // Every --service below targets plan.name — the name this tool gives BOTH the project and the service (`init
  // --name` + `add --service`).
  const svc = ["--service", plan.name];

  // 1.
  if ((await railway(["whoami"], { capture: true })).code !== 0) {
    return gate(
      "not logged in to Railway — run `railway login`, or set RAILWAY_API_TOKEN (an account token), then re-run",
    );
  }

  // 2. Gate missing required secret VALUES before any side effect (no half-created infra).
  const missingValues = missingValuesGate(plan.missingSecrets, plan.valueFile);
  if (missingValues) return gate(missingValues);

  // 3.
  const status = await railway(["status", "--json"], { capture: true });
  if (isLinked(status.stdout)) {
    if (!plan.intoLinked) {
      const name = linkedName(status.stdout);
      return gate(
        `this directory is already linked to Railway project ${name ? `"${name}"` : "(name unreadable)"}. ` +
          "`--run` provisions a NEW project and only runs on an unlinked directory — it won't deploy into an " +
          "unrelated one. To redeploy an already-provisioned agent, run `railway up`. To provision the agent " +
          "INTO this project, re-run with --into-linked. To start fresh, `railway unlink` first.",
      );
    }
    log(`provisioning into linked project ${linkedName(status.stdout) ?? plan.name} (--into-linked)`);
  } else {
    // --into-linked means "provision into the project this dir is linked to" — but it isn't linked.
    if (plan.intoLinked) {
      log("warn: --into-linked was passed but this directory isn't linked to any project — creating a fresh one");
    }
    log(`creating project ${plan.name}…`);
    if ((await railway(["init", "--name", plan.name])).code !== 0) {
      return gate(
        "`railway init` failed — if you have multiple workspaces, run it once interactively (or pass --workspace) to pick one, then re-run",
      );
    }
    // Create + link the service (init makes only a project); it precedes the volume, which has no --service flag and
    // rides the linked service.
    log(`creating service ${plan.name}…`);
    if ((await railway(["add", "--service", plan.name])).code !== 0) {
      // Precise recovery, not "fix and re-run": init already created + linked the project, so a plain re-run hits the
      // linked-gate, and --into-linked SKIPS `add` and then fails at the volume (no service to ride).
      return gate(
        `\`railway add --service\` failed — \`railway init\` already created the project (this directory is now ` +
          `linked) but not the service. Finish with \`railway add --service ${plan.name}\` here, then re-run with ` +
          `--into-linked; or \`railway unlink\` to detach and start fresh.`,
      );
    }
  }

  // 3b.
  const machineryVars = [
    `FASTAGENT_STATE_DIR=${plan.mountPath}/.state`,
    `FASTAGENT_SECRETS_DIR=${plan.mountPath}/.secrets`,
    `RAILWAY_DOCKERFILE_PATH=${plan.dockerfilePath}`,
  ];
  // The secret NAMES, not a count: `--run` uploads the whole value file, so the operator has to be able to see the
  // list on every host.
  const secretNames = Object.keys(plan.secrets);
  log(
    `setting ${machineryVars.map((v) => v.split("=")[0]).join("/")} + ${secretNames.length} secret(s)` +
      `${secretNames.length > 0 ? `: ${secretNames.join(", ")}` : ""}…`,
  );
  if ((await railway(["variables", "set", ...machineryVars, ...svc])).code !== 0) {
    return gate("`railway variables set` failed — see the railway output above");
  }
  for (const [k, v] of Object.entries(plan.secrets)) {
    if ((await railway(["variables", "set", k, "--stdin", ...svc], { input: v })).code !== 0) {
      return gate(`\`railway variables set ${k}\` failed — see the railway output above`);
    }
  }

  // 3c.
  const volumeStatus = async () =>
    volumeOn((await railway(["volume", "list", "--json"], { capture: true })).stdout, plan.name, plan.mountPath);
  if ((await volumeStatus()) !== undefined) {
    log(`volume at ${plan.mountPath} exists on ${plan.name} — skipping`);
  } else {
    log(`creating volume at ${plan.mountPath}…`);
    if ((await railway(["volume", "add", "--mount-path", plan.mountPath])).code !== 0) {
      return gate("`railway volume add` failed — see the railway output above");
    }
    // Deploying before the volume is attached boots a container with no volume, which `start` refuses (it must
    // never seed a workspace onto a disk that vanishes on restart).
    let status: string | undefined;
    for (let waited = 0; ; waited += VOLUME_POLL_MS) {
      status = await volumeStatus();
      if (status === "Ready" || waited >= VOLUME_ATTACH_TIMEOUT_MS) break;
      await sleep(VOLUME_POLL_MS);
    }
    if (status !== "Ready") {
      return gate(
        `the volume at ${plan.mountPath} is not attached to service ${plan.name} after ` +
          `${VOLUME_ATTACH_TIMEOUT_MS / 1000}s (${status === undefined ? "not listed on it" : `status ${status}`}) — ` +
          "check `railway volume list`, then re-run with --into-linked once it shows Ready",
      );
    }
  }

  // 5. Deploy — CI mode streams build logs then exits (no interactive attach). Build runs on Railway.
  log("deploying (railway up)…");
  if ((await railway(["up", "--ci", ...svc])).code !== 0) {
    return gate("`railway up` failed — see the railway output above; fix and re-run");
  }

  // 6.
  log("getting the public domain…");
  const url = parseDomainUrl((await railway(["domain", "--json", ...svc], { capture: true })).stdout);
  if (!url) {
    return gate("couldn't read a domain from `railway domain` — run `railway domain` manually, then set any webhook");
  }
  // 6b. `railway up --ci` exits 0 once the build is accepted, so readiness is asked here and not inferred.
  const healthGate = await publicHealthGate({
    baseUrl: url,
    channels: plan.channels,
    log,
    inspectHint: "the service itself deployed — inspect `railway logs`, then re-run once it answers",
    probe: healthProbe,
    loginFollows: plan.boxLogin !== undefined,
  });
  if (healthGate) return gate(healthGate);
  const notLoggedIn = await plan.boxLogin?.();
  if (notLoggedIn) return gate(notLoggedIn);

  // 7.
  const registrationGateMsg = await registerWebhooks({
    baseUrl: url,
    channels: plan.channels,
    registrars,
    log,
    retryHint: "re-run with --into-linked to retry registration",
  });
  if (registrationGateMsg) return gate(registrationGateMsg);
  return { ok: true, url };
}
