/**
 * `fastagent deploy docker --run` — reconcile the generated/user-owned Compose application locally.
 * Compose owns container/network/volume lifecycle; this driver owns only actionable gates, secret/auth
 * carry through the child environment (never argv), and a readiness check on the published loopback port.
 */
import { waitForHealth } from "../../channels/wait-health.ts";
import { parseTunnelUrl } from "../../tunnel.ts";
import type { CliRunner } from "../runner.ts";

export interface DockerRunPlan {
  /** Compose file relative to the runner cwd (the workspace root). */
  composeFile: string;
  /** Container port from config; used to ask Compose for the effective published host port. */
  port: number;
  /** Values interpolated by Compose. Keys/values are passed in the child environment, never argv. */
  secrets: Record<string, string>;
  /** Required names with no local value; gate before build/create. */
  missingSecrets: string[];
  /** Neither an env-key credential nor a readable auth.json is available. */
  needsModelCredential: boolean;
  /** `--tunnel` was requested for this run; a kept Compose file must actually contain that service. */
  requireTunnel: boolean;
}

export type DockerRunOutcome = { ok: true; url?: string; tunnelUrl?: string } | { ok: false; gate: string };

export type DockerHealthProbe = (healthUrl: string) => Promise<boolean>;
export type DockerTunnelUrlProbe = (
  docker: CliRunner,
  composeFile: string,
  env: NodeJS.ProcessEnv,
) => Promise<string | undefined>;

/** Resolve Docker Compose's `host:port` output to a loopback URL (safe for 0.0.0.0/[::] bindings too). */
export function localUrlFromComposePort(stdout: string): string | undefined {
  const line = stdout
    .split("\n")
    .map((value) => value.trim())
    .find(Boolean);
  const port = line?.match(/:(\d+)$/)?.[1];
  return port ? `http://127.0.0.1:${port}` : undefined;
}

const defaultHealthProbe: DockerHealthProbe = (healthUrl) => waitForHealth(healthUrl, 30_000, 500);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll the detached cloudflared service's logs until its assigned Quick Tunnel URL appears. */
export async function waitForComposeTunnelUrl(
  docker: CliRunner,
  composeFile: string,
  env: NodeJS.ProcessEnv,
  options: { attempts?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<string | undefined> {
  const compose = ["compose", "-f", composeFile];
  const attempts = options.attempts ?? 60;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const logs = await docker([...compose, "logs", "--no-color", "tunnel"], { capture: true, env });
    const url = logs.code === 0 ? parseTunnelUrl(logs.stdout) : undefined;
    if (url) return url;
    if (attempt + 1 < attempts) await (options.sleep ?? sleep)(options.intervalMs ?? 500);
  }
  return undefined;
}

const defaultTunnelUrlProbe: DockerTunnelUrlProbe = (docker, composeFile, env) =>
  waitForComposeTunnelUrl(docker, composeFile, env);

/**
 * Drive Docker Compose. A custom Compose file remains authoritative: the driver invokes it as-is and
 * only assumes the generated service contract (`agent`, config's container port) for optional URL/
 * readiness reporting. If the service intentionally has no host-published port, a successful running
 * service is still success (an operator-owned sidecar/reverse proxy may be its only ingress).
 */
export async function deployDockerRun(
  plan: DockerRunPlan,
  docker: CliRunner,
  log: (message: string) => void,
  healthProbe: DockerHealthProbe = defaultHealthProbe,
  tunnelUrlProbe: DockerTunnelUrlProbe = defaultTunnelUrlProbe,
): Promise<DockerRunOutcome> {
  const gate = (message: string): DockerRunOutcome => ({ ok: false, gate: message });
  const compose = ["compose", "-f", plan.composeFile];
  const env = plan.secrets;

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
  if (plan.missingSecrets.length > 0) {
    return gate(
      `no local value for: ${plan.missingSecrets.join(", ")} — set them in .env (or the environment) and re-run`,
    );
  }

  if ((await docker(["info"], { capture: true })).code !== 0) {
    return gate("Docker daemon is unavailable — start Docker Engine/Desktop, then re-run");
  }

  // The file on disk is authoritative. Inspect its actual services before any build/create side effect,
  // both to protect the `agent` run contract and to catch `--tunnel` against a kept non-tunnel topology.
  const configured = await docker([...compose, "config", "--services"], { capture: true, env });
  if (configured.code !== 0) {
    return gate(`invalid Compose file — fix ${plan.composeFile}, then re-run`);
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

  // Quick Tunnel logs are the control-plane output (the assigned URL). Remove its old container first so
  // a rerun cannot read a stale URL from accumulated logs; `up` below creates one fresh tunnel, then the
  // CLI registers that URL. The app container/volume are untouched.
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

  // Detached `up` can return 0 just before a bad command exits. Verify the expected service is actually
  // running so a broken custom Dockerfile/CMD cannot look deployed. Compose restart loops are excluded.
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
  // In that case Compose `port` is absent/non-zero: service-running is the available readiness floor.
  const published = await docker([...compose, "port", "agent", String(plan.port)], { capture: true, env });
  const url = published.code === 0 ? localUrlFromComposePort(published.stdout) : undefined;
  if (!url) {
    log("agent is running (no host-published port found; using the Compose ingress readiness floor)");
  } else {
    const healthUrl = `${url}/health`;
    if (!(await healthProbe(healthUrl))) {
      return gate(
        `agent did not become healthy at ${healthUrl} — inspect \`docker compose -f ${plan.composeFile} logs agent\``,
      );
    }
  }

  if (!hasTunnel) return { ok: true, url };
  log("waiting for the Compose tunnel service to publish its Quick Tunnel URL…");
  const tunnelUrl = await tunnelUrlProbe(docker, plan.composeFile, env);
  if (!tunnelUrl) {
    return gate(
      `tunnel did not publish a Quick Tunnel URL — inspect \`docker compose -f ${plan.composeFile} logs tunnel\``,
    );
  }
  return { ok: true, url, tunnelUrl };
}
