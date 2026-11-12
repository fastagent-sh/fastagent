/** `fastagent deploy docker --run` — reconcile the generated/user-owned Compose application locally. */
import { connect } from "node:net";
import type { BoxLoginStep } from "../box-shell.ts";
import { waitForHealth } from "../../channels/wait-health.ts";
import { MIN_DOCKER_COMPOSE_VERSION } from "./plan.ts";
import { type CliRunner, readOutput } from "../runner.ts";

export interface DockerRunPlan {
  /** Compose file relative to the runner cwd (the agent directory). */
  composeFile: string;
  /** Container port from config; used to ask Compose for the effective published host port. */
  port: number;
  /**
   * Make sure the environment Compose will run in holds a value for every name the deployment needs: resolves a gate
   * line, or undefined. Nothing travels through this process but the names it checks.
   */
  checkValues: () => string | undefined;
  /**
   * Log the box in (`fastagent login --deployment`) once it is up and before any webhook is pointed at it: a channel pointed at
   * a box with no model credential answers every message with a failure. Resolves a gate line, or undefined.
   */
  boxLogin?: BoxLoginStep;
}

export type DockerRunOutcome =
  | { ok: true; url?: string }
  /** `url` travels with a gate too: Compose is up, so the operator still needs to know where. */
  | { ok: false; gate: string; url?: string };

/**
 * `stillStarting` answers whether the agent container is still up; a probe that ignores it simply waits out its whole
 * budget.
 */
export type DockerHealthProbe = (healthUrl: string, stillStarting: () => Promise<boolean>) => Promise<boolean>;
/**
 * Whether something already accepts connections at `host:port`. The answer to "is the port the agent is about to
 * publish free", asked before `up`, because afterwards a `/health` that answers cannot say whose it is.
 */
export type HostPortProbe = (host: string, port: number) => Promise<boolean>;
/** Resolve Docker Compose's `host:port` output to a loopback URL (safe for 0.0.0.0/[::] bindings too). */
function localUrlFromComposePort(stdout: string): string | undefined {
  const line = stdout
    .split("\n")
    .map((value) => value.trim())
    .find(Boolean);
  const port = line?.match(/:(\d+)$/)?.[1];
  return port ? `http://127.0.0.1:${port}` : undefined;
}

/**
 * The boot publishes the definition onto the volume (the image's `node_modules` included) before it binds a port,
 * so this budget covers a copy on a slow Docker Desktop disk, not a listen.
 */
const defaultHealthProbe: DockerHealthProbe = (healthUrl, stillStarting) =>
  waitForHealth(healthUrl, 180_000, 500, stillStarting);
const defaultHostPortBusy: HostPortProbe = (host, port) =>
  new Promise((resolve) => {
    const socket = connect({ host, port });
    const answer = (busy: boolean) => {
      socket.destroy();
      resolve(busy);
    };
    socket.setTimeout(1_000, () => answer(false)); // a filtered port is not one something is serving
    socket.once("connect", () => answer(true));
    socket.once("error", () => answer(false));
  });

/**
 * The host ports the `agent` service publishes, from `docker compose config --format json` (Compose has already
 * normalised every short or long syntax into `ports[]`). A port with no fixed host side (`published` unset: Docker picks
 * one) cannot collide and is left out. A wildcard bind is asked on loopback, which is where the URL we report points.
 */
function agentPublishedPorts(stdout: string): { host: string; port: number }[] {
  const config: unknown = JSON.parse(stdout);
  const ports = (config as { services?: { agent?: { ports?: unknown } } } | null)?.services?.agent?.ports;
  if (ports === undefined) return [];
  if (!Array.isArray(ports)) throw new Error("services.agent.ports is not a list");
  return ports.flatMap((entry: { published?: string | number; host_ip?: string; protocol?: string }) => {
    const port = Number(entry?.published);
    if (!Number.isInteger(port) || port <= 0 || (entry.protocol ?? "tcp") !== "tcp") return [];
    const wildcard = !entry.host_ip || entry.host_ip === "0.0.0.0" || entry.host_ip === "::";
    return [{ host: wildcard ? "127.0.0.1" : (entry.host_ip as string), port }];
  });
}
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `/health` asked from inside the agent container, for a topology that publishes no host port. The image always has
 * node or bun (the generated Dockerfile's base), and both have `fetch`; nothing else is assumed installed.
 */
async function containerHealthy(
  docker: CliRunner,
  compose: string[],
  port: number,
  stillStarting: () => Promise<boolean>,
): Promise<boolean> {
  const probe =
    `r=$(command -v node || command -v bun) && "$r" -e ` +
    `"fetch('http://127.0.0.1:${port}/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"`;
  const deadline = Date.now() + 180_000; // the same first-boot budget as the published-port probe
  while (Date.now() < deadline) {
    if ((await docker([...compose, "exec", "-T", "agent", "sh", "-c", probe], { capture: true })).code === 0)
      return true;
    if (!(await stillStarting())) return false;
    await sleep(1_000);
  }
  return false;
}

export async function deployDockerRun(
  plan: DockerRunPlan,
  docker: CliRunner,
  log: (message: string) => void,
  healthProbe: DockerHealthProbe = defaultHealthProbe,
  hostPortBusy: HostPortProbe = defaultHostPortBusy,
): Promise<DockerRunOutcome> {
  const gate = (message: string): DockerRunOutcome => ({ ok: false, gate: message });
  const compose = ["compose", "-f", plan.composeFile];

  // CLI/plugin gate first: unlike a daemon error, spawn ENOENT becomes 127 at the shared runner seam.
  const version = await docker(["compose", "version"], { capture: true });
  if (version.code === 127) {
    return gate("Docker CLI not found — install Docker Engine/Desktop, then re-run");
  }
  if (version.code !== 0) {
    return gate("Docker Compose plugin is unavailable — install/enable `docker compose`, then re-run");
  }

  // The values come before the first side effect (build/create).
  const secretsGate = plan.checkValues();
  if (secretsGate !== undefined) return gate(secretsGate);

  if ((await docker(["info"], { capture: true })).code !== 0) {
    return gate("Docker daemon is unavailable — start Docker Engine/Desktop, then re-run");
  }

  // The file on disk is authoritative.
  const configured = await docker([...compose, "config", "--services"], { capture: true });
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

  // A port something else already serves would answer the `/health` this run waits for, and the run would report that
  // process's answer as the agent's. A container this project already runs holds its own port, so only a first start
  // (or a start after `down`) asks. Before the first side effect: a refusal leaves nothing to undo.
  const hostPorts = await readOutput(docker, "docker", [...compose, "config", "--format", "json"], agentPublishedPorts);
  if ("gate" in hostPorts) return gate(hostPorts.gate);
  if (hostPorts.value.length > 0) {
    const running = await docker([...compose, "ps", "--status", "running", "--services"], { capture: true });
    const ours = running.code === 0 && running.stdout.split(/\s+/).includes("agent");
    if (!ours) {
      for (const { host, port } of hostPorts.value) {
        if (await hostPortBusy(host, port)) {
          return gate(
            `${host}:${port} is already in use by another process, so the agent's published port is not free and a ` +
              `health check there would answer for that process, not for the agent — stop it, or move the agent: ` +
              `edit the published port in ${plan.composeFile}, or change defaults.http.port in fastagent.config.ts and re-run ` +
              `with --force (a generated Compose file is kept otherwise)`,
          );
        }
      }
    }
  }

  log(`building and reconciling ${plan.composeFile}…`);
  // `--pull`: the base image is a floating tag, and a copy cached here may be older than the runtime floor.
  if ((await docker([...compose, "build", "--pull"])).code !== 0) {
    return gate(`\`docker compose build\` failed — see the Docker output above; fix it and re-run`);
  }
  if ((await docker([...compose, "up", "-d"])).code !== 0) {
    return gate(`\`docker compose up\` failed — see the Docker output above; fix ${plan.composeFile} and re-run`);
  }

  // Detached `up` can return 0 just before a bad command exits.
  const running = await docker([...compose, "ps", "--status", "running", "--services"], { capture: true });
  const runningServices = running.stdout.split(/\s+/).filter(Boolean);
  if (running.code !== 0 || !runningServices.includes("agent")) {
    return gate(
      `the Compose service "agent" is not running — inspect with \`docker compose -f ${plan.composeFile} logs agent\``,
    );
  }

  // A user-owned topology may deliberately remove the host port and expose only through its own ingress.
  const published = await docker([...compose, "port", "agent", String(plan.port)], { capture: true });
  const url = published.code === 0 ? localUrlFromComposePort(published.stdout) : undefined;
  // Throttled, and an unreadable answer reads as "still starting": the health poll runs twice a second, and a
  // `compose ps` per poll would cost more than the wait it shortens.
  let lastCheck = Date.now();
  const stillStarting = async (): Promise<boolean> => {
    if (Date.now() - lastCheck < 5_000) return true;
    lastCheck = Date.now();
    const ps = await docker([...compose, "ps", "--status", "running", "--services"], { capture: true });
    return ps.code !== 0 || ps.stdout.split(/\s+/).includes("agent");
  };
  if (!url && plan.boxLogin) {
    // The login runs in the deployed definition, with the CLI the first boot installs: it needs the box READY, and
    // with no published port the only place to ask `/health` is inside the container.
    log("agent is running (no host-published port found); waiting for /health inside the container before login…");
    if (!(await containerHealthy(docker, compose, plan.port, stillStarting))) {
      return gate(
        `agent did not become healthy inside the container — inspect \`docker compose -f ${plan.composeFile} logs agent\``,
      );
    }
  } else if (!url) {
    log("agent is running (no host-published port found; using the Compose ingress readiness floor)");
  } else {
    const healthUrl = `${url}/health`;
    if (!(await healthProbe(healthUrl, stillStarting))) {
      return gate(
        `agent did not become healthy at ${healthUrl} — inspect \`docker compose -f ${plan.composeFile} logs agent\``,
      );
    }
  }

  // `url` travels with this gate: Compose is up, and the operator needs to know where.
  const notLoggedIn = await plan.boxLogin?.run();
  if (notLoggedIn) return { ok: false, gate: notLoggedIn, url };
  return { ok: true, url };
}
