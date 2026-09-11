/** `fastagent deploy docker --run` — reconcile the generated/user-owned Compose application locally. */
import { waitForHealth } from "../../channels/wait-health.ts";
import { TUNNEL_DNS_LAG_MS, hasTunnelConnection, parseTunnelUrl } from "../../tunnel.ts";
import type { RegistrationOutcome } from "../../channels/registration.ts";
import { registrationGate } from "../registration-gate.ts";
import { MIN_DOCKER_COMPOSE_VERSION } from "./plan.ts";
import type { CliRunner } from "../runner.ts";
import { missingValuesGate } from "../secrets.ts";

export interface DockerRunPlan {
  /** Compose file relative to the runner cwd (the workspace root). */
  composeFile: string;
  /** Container port from config; used to ask Compose for the effective published host port. */
  port: number;
  /** Values interpolated by Compose. */
  secrets: Record<string, string>;
  /**
   * Every name the generated Compose interpolates (`composeInterpolatedNames`). The child's environment inherits
   * this process's, so any of these left unset here would be filled from the BUILDER'S SHELL — exactly the source
   * the value file replaced. They are blanked first, then overwritten by `secrets`.
   */
  interpolated: readonly string[];
  /** Declared names the value file supplies no value for — the run gates on these before any side effect. */
  missingSecrets: string[];
  /** That value file, workspace-relative, so the gate names the file this deploy actually read. */
  valueFile: string;
  /** Neither an env-key credential nor a readable auth.json is available. */
  needsModelCredential: boolean;
  /** Register the deployment's webhooks against the tunnel URL, reporting what each registrar answered. */
  announce: DockerAnnounce;
  /** `--tunnel` was requested for this run; a kept Compose file must actually contain that service. */
  requireTunnel: boolean;
}

export type DockerRunOutcome =
  | { ok: true; url?: string; tunnelUrl?: string }
  /**
   * `url`/`tunnelUrl` travel with a gate too: Compose is up, so the operator still needs to know where it is and what
   * to re-run.
   */
  | { ok: false; gate: string; url?: string; tunnelUrl?: string };

/** Register the deployment's webhooks against its public URL, reporting what each registrar answered. */
type DockerAnnounce = (baseUrl: string) => Promise<{ kind: string; outcome: RegistrationOutcome }[]>;

/**
 * `stillStarting` answers whether the agent container is still up; a probe that ignores it simply waits out its whole
 * budget.
 */
export type DockerHealthProbe = (healthUrl: string, stillStarting: () => Promise<boolean>) => Promise<boolean>;
/** A published Quick Tunnel URL, and whether its tunnel ever reported an edge connection. */
export interface ComposeTunnel {
  url: string;
  connected: boolean;
}
export type DockerTunnelUrlProbe = (
  docker: CliRunner,
  composeFile: string,
  env: NodeJS.ProcessEnv,
) => Promise<ComposeTunnel | undefined>;

/** Resolve Docker Compose's `host:port` output to a loopback URL (safe for 0.0.0.0/[::] bindings too). */
export function localUrlFromComposePort(stdout: string): string | undefined {
  const line = stdout
    .split("\n")
    .map((value) => value.trim())
    .find(Boolean);
  const port = line?.match(/:(\d+)$/)?.[1];
  return port ? `http://127.0.0.1:${port}` : undefined;
}

/**
 * The FIRST boot seeds the whole workspace onto the volume (the image's `node_modules` included) before it binds a
 * port, so this budget covers a copy on a slow Docker Desktop disk, not a listen.
 */
const defaultHealthProbe: DockerHealthProbe = (healthUrl, stillStarting) =>
  waitForHealth(healthUrl, 180_000, 500, stillStarting);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll the detached cloudflared service's logs until its Quick Tunnel URL is assigned AND the tunnel reports an edge
 * connection.
 */
export async function waitForComposeTunnelUrl(
  docker: CliRunner,
  composeFile: string,
  env: NodeJS.ProcessEnv,
  options: { attempts?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<ComposeTunnel | undefined> {
  const compose = ["compose", "-f", composeFile];
  const attempts = options.attempts ?? 60;
  let assigned: string | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const logs = await docker([...compose, "logs", "--no-color", "tunnel"], { capture: true, env });
    if (logs.code === 0) {
      assigned ??= parseTunnelUrl(logs.stdout);
      if (assigned && hasTunnelConnection(logs.stdout)) {
        await (options.sleep ?? sleep)(TUNNEL_DNS_LAG_MS);
        return { url: assigned, connected: true };
      }
    }
    if (attempt + 1 < attempts) await (options.sleep ?? sleep)(options.intervalMs ?? 500);
  }
  return assigned ? { url: assigned, connected: false } : undefined;
}

const defaultTunnelUrlProbe: DockerTunnelUrlProbe = (docker, composeFile, env) =>
  waitForComposeTunnelUrl(docker, composeFile, env);

export async function deployDockerRun(
  plan: DockerRunPlan,
  docker: CliRunner,
  log: (message: string) => void,
  healthProbe: DockerHealthProbe = defaultHealthProbe,
  tunnelUrlProbe: DockerTunnelUrlProbe = defaultTunnelUrlProbe,
): Promise<DockerRunOutcome> {
  const gate = (message: string): DockerRunOutcome => ({ ok: false, gate: message });
  const compose = ["compose", "-f", plan.composeFile];
  // Blank-then-override: `spawnRunner` merges over `process.env`, so a declared credential name the value file does
  // not supply would otherwise inherit the builder's shell and reach the container. A deployment carries what the
  // value file says and nothing else — including for the optional names the missing-values gate never sees
  // (FASTAGENT_CONTROL_TOKEN, *_ENCRYPT_KEY, FASTAGENT_AUTH_SEED). `NO_PROXY`/`no_proxy` are deliberately NOT in
  // this list (the operator's bypass list is meant to survive), and a KEPT older compose file may interpolate names
  // this definition no longer declares — those still inherit.
  const env: Record<string, string> = {
    ...Object.fromEntries(plan.interpolated.map((name) => [name, ""])),
    ...plan.secrets,
  };

  // CLI/plugin gate first: unlike a daemon error, spawn ENOENT becomes 127 at the shared runner seam.
  const version = await docker(["compose", "version"], { capture: true });
  if (version.code === 127) {
    return gate("Docker CLI not found — install Docker Engine/Desktop, then re-run");
  }
  if (version.code !== 0) {
    return gate("Docker Compose plugin is unavailable — install/enable `docker compose`, then re-run");
  }

  // Credential gates precede the first side effect (build/create), with distinct remediation.
  if (plan.needsModelCredential) {
    return gate("no model credential — run `fastagent login`, or set a provider API key in .env, then re-run");
  }
  const missingValues = missingValuesGate(plan.missingSecrets, plan.valueFile);
  if (missingValues) return gate(missingValues);

  // Name what travels from the value file into the container: the list is no longer only what the
  // author typed in deploy.secrets (a mounted tool/channel/schedule declares its own).
  const secretNames = Object.keys(plan.secrets);
  if (secretNames.length > 0) log(`passing ${secretNames.length} secret(s) to Compose: ${secretNames.join(", ")}`);

  if ((await docker(["info"], { capture: true })).code !== 0) {
    return gate("Docker daemon is unavailable — start Docker Engine/Desktop, then re-run");
  }

  // The file on disk is authoritative.
  const configured = await docker([...compose, "config", "--services"], { capture: true, env });
  if (configured.code !== 0) {
    return gate(
      `could not load ${plan.composeFile} — generated files require Docker Compose >= ` +
        `${MIN_DOCKER_COMPOSE_VERSION}; upgrade Compose or fix the file, then re-run`,
    );
  }
  const services = configured.stdout.split(/\s+/).filter(Boolean);
  if (!services.includes("agent")) {
    return gate(`Compose file must keep the "agent" service for \`fastagent deploy docker --run\``);
  }
  const hasTunnel = services.includes("tunnel");
  if (plan.requireTunnel && !hasTunnel) {
    return gate(
      `--tunnel was requested but the kept ${plan.composeFile} has no "tunnel" service — ` +
        `edit it, delete it and regenerate, or pass --force`,
    );
  }

  // Quick Tunnel logs are the control-plane output (the assigned URL).
  if (hasTunnel) {
    log("recreating the ephemeral tunnel service…");
    if ((await docker([...compose, "rm", "-s", "-f", "tunnel"], { env })).code !== 0) {
      return gate(`could not recreate the tunnel service — inspect \`docker compose -f ${plan.composeFile} ps\``);
    }
  }

  log(`building and reconciling ${plan.composeFile}…`);
  if ((await docker([...compose, "up", "-d", "--build"], { env })).code !== 0) {
    return gate(`\`docker compose up\` failed — see the Docker output above; fix ${plan.composeFile} and re-run`);
  }

  // Detached `up` can return 0 just before a bad command exits.
  const running = await docker([...compose, "ps", "--status", "running", "--services"], {
    capture: true,
    env,
  });
  const runningServices = running.stdout.split(/\s+/).filter(Boolean);
  if (running.code !== 0 || !runningServices.includes("agent")) {
    return gate(
      `the Compose service "agent" is not running — inspect with \`docker compose -f ${plan.composeFile} logs agent\``,
    );
  }
  if (hasTunnel && !runningServices.includes("tunnel")) {
    return gate(
      `the Compose service "tunnel" is not running — inspect with \`docker compose -f ${plan.composeFile} logs tunnel\``,
    );
  }

  // A user-owned topology may deliberately remove the host port and expose only through its own ingress.
  const published = await docker([...compose, "port", "agent", String(plan.port)], { capture: true, env });
  const url = published.code === 0 ? localUrlFromComposePort(published.stdout) : undefined;
  if (!url) {
    log("agent is running (no host-published port found; using the Compose ingress readiness floor)");
  } else {
    const healthUrl = `${url}/health`;
    // Throttled, and an unreadable answer reads as "still starting": the health poll runs twice a second, and a
    // `compose ps` per poll would cost more than the wait it shortens.
    let lastCheck = Date.now();
    const stillStarting = async (): Promise<boolean> => {
      if (Date.now() - lastCheck < 5_000) return true;
      lastCheck = Date.now();
      const ps = await docker([...compose, "ps", "--status", "running", "--services"], { capture: true, env });
      return ps.code !== 0 || ps.stdout.split(/\s+/).includes("agent");
    };
    if (!(await healthProbe(healthUrl, stillStarting))) {
      return gate(
        `agent did not become healthy at ${healthUrl} — inspect \`docker compose -f ${plan.composeFile} logs agent\``,
      );
    }
  }

  if (!hasTunnel) return { ok: true, url };
  log("waiting for the Compose tunnel service to publish its Quick Tunnel URL…");
  const tunnel = await tunnelUrlProbe(docker, plan.composeFile, env);
  if (!tunnel) {
    return gate(
      `tunnel did not publish a Quick Tunnel URL — inspect \`docker compose -f ${plan.composeFile} logs tunnel\``,
    );
  }
  // The same sentence `startCloudflareTunnel` prints for the same state, and needed MORE here.
  if (!tunnel.connected) {
    log(
      `warn: the tunnel service never reported an edge connection for ${tunnel.url} — announcing it anyway. ` +
        `Nothing reaches a tunnel that has not connected, so a webhook registration that cannot resolve the ` +
        `host is this, not the platform. Inspect \`docker compose -f ${plan.composeFile} logs tunnel\`.`,
    );
  }
  const tunnelUrl = tunnel.url;
  // Registration lives HERE, like every other host's driver, and not at the CLI: this is the layer that owns the
  // outcome, so it is the layer that can gate on one.
  const reg = registrationGate(log, `re-run this deploy to retry registration (Compose is already up)`);
  for (const { kind, outcome } of await plan.announce(tunnelUrl)) reg.track(kind, outcome);
  const blocked = reg.gate();
  if (blocked) return { ok: false, gate: blocked, url, tunnelUrl };
  return { ok: true, url, tunnelUrl };
}
