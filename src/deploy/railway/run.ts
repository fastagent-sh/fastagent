/** `fastagent deploy railway --run` — drive the Railway CLI to completion. */
import type { BoxLoginStep } from "../box-shell.ts";
import {
  type BoxWebhooksProbe,
  type UrlRecorder,
  type PublicHealthProbe,
  type Registrars,
  confirmWebhooks,
  loginGate,
  publicHealthGate,
} from "../channel-ingress.ts";
import type { DeclaredChannel } from "../../channels/discover.ts";
import { type CliRunner, readOutput } from "../runner.ts";
import type { SecretStore } from "../secret-store.ts";
import { hostSignedOutGate } from "../secrets.ts";
import { ensureRailwayService, railwayStore } from "./store.ts";

export interface RailwayRunPlan {
  /** At a terminal with a `--config` file: record each URL a person set once the box confirms it. */
  recordUrl?: UrlRecorder;
  /** Names both the project (`railway init --name`) and the service (`railway add --service`). */
  name: string;
  /**
   * The volume mount path; `FASTAGENT_STATE_DIR`/`FASTAGENT_SECRETS_DIR` are set to `.state`/`.secrets` under it (kept
   * in lockstep).
   */
  mountPath: string;
  /**
   * Make sure the service holds a value for every name the deployment needs, through whoever can supply one
   * (secret-store.ts): resolves a gate line, or undefined. It runs once the service exists.
   */
  provideSecrets: (store: SecretStore) => Promise<string | undefined>;
  /** Every declared channel and its ingress — the driver asks which of them have a webhook. */
  channels: readonly DeclaredChannel[];
  /** Opt-in (CLI `--into-linked`) to provision INTO the project this directory is already linked to. */
  intoLinked: boolean;
  /**
   * Log the box in (`fastagent login --deployment`) once it is up and before any webhook is pointed at it: a channel pointed at
   * a box with no model credential answers every message with a failure. Resolves a gate line, or undefined.
   */
  boxLogin?: BoxLoginStep;
  /**
   * Sign the host's CLI in when it is signed out, through whoever can (host-login.ts): resolves a gate line, or
   * undefined once signed in. Absent: nobody can, and the run stops naming how.
   */
  hostLogin?: () => Promise<string | undefined>;
  /** The command a coding agent runs to deploy this, its person's steps handed to its user (`--run --json`). */
  forAgent: string;
  /**
   * The variables that vary per instance, with the service's domain in the configuration (`http.publicUrl`) so the box
   * points its own channels there, and the URL the configuration then names: the operator's own when it had one.
   */
  delivery: (url: string) => { variables: Record<string, string>; publicUrl: string };
}

/**
 * Done (with the live URL), or a gate the operator must clear before re-running (printed + non-zero exit by the CLI).
 */
export type RailwayRunOutcome = { ok: true; url: string } | { ok: false; gate: string };

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
 * one. Read from any object carrying `mountPath` and `serviceName`, so a wrapper key moving does not matter. Output
 * that is not JSON throws: read as "no volume", it would add a second one.
 */
export function volumeOn(stdout: string, service: string, mountPath: string): string | undefined {
  const walk = (v: unknown): string | undefined => {
    if (Array.isArray(v)) return v.map(walk).find((status) => status !== undefined);
    if (!v || typeof v !== "object") return undefined;
    const o = v as Record<string, unknown>;
    if (o.mountPath === mountPath && o.serviceName === service) return typeof o.status === "string" ? o.status : "";
    return walk(Object.values(o));
  };
  return walk(JSON.parse(stdout));
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
  /** Slack's, which this machine still sets (its Request URL no credential on the box can change). */
  registrars: Pick<Registrars, "leave">,
  healthProbe?: PublicHealthProbe,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  boxWebhooks?: { probe: BoxWebhooksProbe; intervalMs?: number },
): Promise<RailwayRunOutcome> {
  const gate = (g: string): RailwayRunOutcome => ({ ok: false, gate: g });
  // Every --service below targets plan.name — the name this tool gives BOTH the project and the service (`init
  // --name` + `add --service`).
  const svc = ["--service", plan.name];

  // 2.
  if ((await railway(["whoami"], { capture: true })).code !== 0) {
    const failed = plan.hostLogin
      ? await plan.hostLogin()
      : hostSignedOutGate("Railway", "railway login", "RAILWAY_API_TOKEN (an account token)", plan.forAgent);
    if (failed) return gate(failed);
  }

  // 3.
  const projectGate = await ensureRailwayService(
    railway,
    { name: plan.name, mountPath: plan.mountPath, intoLinked: plan.intoLinked },
    log,
  );
  if (projectGate !== undefined) return gate(projectGate);

  // 3a. The names the service holds, the gaps filled.
  const secretsGate = await plan.provideSecrets(railwayStore(railway, plan.name, log, { redeploy: false }));
  if (secretsGate !== undefined) return gate(secretsGate);

  // 3b.
  const machineryVars = [
    `FASTAGENT_STATE_DIR=${plan.mountPath}/.state`,
    `FASTAGENT_SECRETS_DIR=${plan.mountPath}/.secrets`,
  ];
  log(`setting ${machineryVars.map((v) => v.split("=")[0]).join("/")}…`);
  if ((await railway(["variables", "set", ...machineryVars, ...svc])).code !== 0) {
    return gate("`railway variables set` failed — see the railway output above");
  }

  // 3c.
  const volumeStatus = () =>
    readOutput(railway, "railway", ["volume", "list", "--json"], (out) => volumeOn(out, plan.name, plan.mountPath));
  const existing = await volumeStatus();
  if ("gate" in existing) return gate(existing.gate);
  if (existing.value !== undefined) {
    log(`volume at ${plan.mountPath} exists on ${plan.name} — skipping`);
  } else {
    log(`creating volume at ${plan.mountPath}…`);
    if ((await railway(["volume", "add", "--mount-path", plan.mountPath])).code !== 0) {
      return gate("`railway volume add` failed — see the railway output above");
    }
    // Deploying before the volume is attached boots a container with no volume, which `start` refuses (it must
    // never publish a definition onto a disk that vanishes on restart).
    let status: string | undefined;
    for (let waited = 0; ; waited += VOLUME_POLL_MS) {
      const read = await volumeStatus();
      if ("gate" in read) return gate(read.gate);
      status = read.value;
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

  // 5. The domain before the upload: `railway domain` creates the service's on a service never deployed, and answers
  // the existing one when run again, so the image the upload builds names it as its `http.publicUrl`.
  log("getting the public domain…");
  const url = parseDomainUrl((await railway(["domain", "--json", ...svc], { capture: true })).stdout);
  if (!url) {
    return gate("couldn't read a domain from `railway domain` — run `railway domain` manually, then set any webhook");
  }
  const { variables, publicUrl } = plan.delivery(url);
  log(`setting ${Object.keys(variables).join("/")}…`);
  // `railway up` follows, so a deploy of the variables alone would only be a second one.
  const delivered = Object.entries(variables).map(([name, value]) => `${name}=${value}`);
  if ((await railway(["variables", "set", ...delivered, "--skip-deploys", ...svc])).code !== 0) {
    return gate("`railway variables set` failed — see the railway output above");
  }

  // 6. Deploy — CI mode streams build logs then exits (no interactive attach). Build runs on Railway.
  log("deploying (railway up)…");
  if ((await railway(["up", "--ci", ...svc])).code !== 0) {
    return gate("`railway up` failed — see the railway output above; fix and re-run");
  }
  // 6b. `railway up --ci` exits 0 once the build is accepted, so readiness is asked here and not inferred.
  const healthGate = await publicHealthGate({
    baseUrl: url,
    channels: plan.channels,
    log,
    inspectHint: "the service itself deployed — inspect `railway logs`, then re-run once it answers",
    probe: healthProbe,
    ...(plan.boxLogin ? { login: plan.boxLogin.command } : {}),
  });
  if (healthGate) return gate(healthGate);
  const notLoggedIn = await plan.boxLogin?.run();
  if (notLoggedIn) {
    return gate(
      loginGate({
        notLoggedIn,
        channels: plan.channels,
        log,
        baseUrl: url,
        afterLogin: "re-run `fastagent deploy railway --run --into-linked` (it keeps the login)",
      }),
    );
  }

  // 7.
  // The box points its own channels at the `http.publicUrl` delivered above; this reads what it made of them.
  const registrationGateMsg = await confirmWebhooks({
    baseUrl: url,
    publicUrl,
    channels: plan.channels,
    registrars,
    log,
    ...(plan.recordUrl === undefined ? {} : { record: plan.recordUrl }),
    retryHint: "re-run with --into-linked to retry registration",
    ...(boxWebhooks === undefined
      ? {}
      : {
          probe: boxWebhooks.probe,
          ...(boxWebhooks.intervalMs === undefined ? {} : { intervalMs: boxWebhooks.intervalMs }),
        }),
  });
  if (registrationGateMsg) return gate(registrationGateMsg);
  return { ok: true, url };
}
