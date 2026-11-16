/**
 * `fastagent dev`: a SUPERVISOR that spawns a worker (this command with FASTAGENT_DEV_WORKER set) to assemble + serve,
 * restarting it on agent edits.
 */
import { listenForRestart, runDevSupervisor } from "../../dev-supervisor.ts";
import { setLogLevel } from "../../log.ts";
import { markDevServe } from "../../serving-command.ts";
import { selectAgentEnvironment } from "../../paths.ts";
import { loadSourceDefinition } from "../../harnesses/pi-durable/open.ts";
import { openServing } from "../../harnesses/pi-durable/serve.ts";
import { DEFAULT_HTTP_PORT, serveAgent } from "../../service.ts";
import { failStartup } from "../fail.ts";
import { cliMountOptions, serveService } from "../serve.ts";
import { setUpMissingChannels } from "../first-run-channels.ts";
import { type InstanceFlags, instanceInputs } from "../instance.ts";
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
  /** false ⇔ `--no-input`. */
  input?: boolean;
  instance?: InstanceFlags;
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
  // Once, in the parent: the worker inherits what it writes, and a restart does not ask again.
  if (!isWorker) await setUpMissingChannels(agentDir, opts);
  if (isWorker || opts.watch === false) {
    await serveOnce(agentDir, modelSpec, opts);
    return;
  }
  // Flag-shape checks before spawning.
  parsePort(opts.port, "--port", "flag");
  parseBind(opts.bind);
  await runDevSupervisor(agentDir);
}

/** Assemble the agent and serve it once (the dev worker; also the --no-watch path). */
async function serveOnce(agentDir: string, modelSpec: string, opts: DevOptions): Promise<void> {
  const portFlag = parsePort(opts.port, "--port", "flag");
  const host = parseBind(opts.bind) ?? DEV_BIND;
  const opened = await loadSourceDefinition(agentDir)
    .then((definition) => openServing(definition, { model: modelSpec, ...instanceInputs(agentDir) }))
    .catch(failStartup);
  await reportAssembly(opened, modelSpec);
  const service = await serveAgent(opened, cliMountOptions()).catch(failStartup);
  serveService(service, { port: portFlag ?? DEFAULT_HTTP_PORT, host });
}
