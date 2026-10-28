/**
 * `fastagent dev`: a SUPERVISOR that spawns a worker (this command with FASTAGENT_DEV_WORKER set) to assemble + serve,
 * restarting it on agent edits.
 */
import { listenForRestart, runDevSupervisor } from "../../dev-supervisor.ts";
import { setLogLevel } from "../../log.ts";
import { markDevServe } from "../../serving-command.ts";
import { selectAgentEnvironment } from "../../paths.ts";
import { openServing } from "../../harnesses/pi-durable/serve.ts";
import { DEFAULT_HTTP_PORT, serveAgent } from "../../service.ts";
import { failStartup } from "../fail.ts";
import { assertTunnelBindable, cliMountOptions, serveService } from "../serve.ts";
import { enterAgentCommand, parseBind, parsePort, reportAssembly } from "../shared.ts";

/**
 * `dev` binds loopback unless `--bind` says otherwise: a dev serve carries the agent's full tool authority and lands on
 * networks its author does not own. `--bind 0.0.0.0` gives back the reach a container or a phone needs.
 */
const DEV_BIND = "127.0.0.1";

export interface DevOptions {
  port?: string;
  bind?: string;
  model?: string;
  /** false ⇔ `--no-watch`. */
  watch?: boolean;
  tunnel?: boolean;
  /** false ⇔ `--no-input`. */
  input?: boolean;
}

export async function runDev(dirArg: string, opts: DevOptions): Promise<void> {
  setLogLevel("debug"); // dev posture: verbose, includes the debug turn trace (content) — supervisor and worker both
  selectAgentEnvironment("dev");
  markDevServe(); // the worker inherits both selections
  const isWorker = process.env.FASTAGENT_DEV_WORKER === "1";
  // First, so a restart asked for while the worker is still assembling is heard: with nothing running it stops at once.
  if (isWorker)
    process.on(
      "message",
      listenForRestart(() => process.kill(process.pid, "SIGTERM")),
    );
  // The model is picked ONCE, in the parent process (a TTY; watch and --no-watch both).
  const { agentDir, modelSpec } = await enterAgentCommand(dirArg, { ...opts, input: isWorker ? false : opts.input });
  if (isWorker || opts.watch === false) {
    await serveOnce(agentDir, modelSpec, opts);
    return;
  }
  parsePort(opts.port, "--port", "flag"); // flag-shape checks before spawning
  // The --bind/--tunnel conflict is decidable from flags alone: refuse it HERE, before a worker and a tunnel exist.
  assertTunnelBindable(parseBind(opts.bind), opts.tunnel ?? false);
  await runDevSupervisor(agentDir, { tunnel: opts.tunnel ?? false });
}

/** Assemble the agent and serve it once (the dev worker; also the --no-watch path). */
async function serveOnce(agentDir: string, modelSpec: string, opts: DevOptions): Promise<void> {
  const portFlag = parsePort(opts.port, "--port", "flag");
  const host = parseBind(opts.bind) ?? DEV_BIND;
  const tunnel = opts.tunnel ?? false;
  assertTunnelBindable(host, tunnel);
  const opened = await openServing(agentDir, { model: modelSpec }).catch(failStartup);
  await reportAssembly(opened, modelSpec);
  const service = await serveAgent(opened, cliMountOptions()).catch(failStartup);
  serveService(
    service,
    { port: portFlag ?? opened.definition.config.http?.port ?? DEFAULT_HTTP_PORT, host },
    { tunnel, agentDir, stateRoot: opened.stateRoot },
  );
}
