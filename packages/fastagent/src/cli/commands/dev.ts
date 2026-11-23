/**
 * `fastagent dev`: a SUPERVISOR that spawns a worker (this command with FASTAGENT_DEV_WORKER set) to assemble + serve,
 * restarting it on agent edits.
 */
import { listenForRestart, runDevSupervisor } from "../dev-supervisor.ts";
import { setLogLevel } from "../../log.ts";
import { markDevServe } from "../../serving-command.ts";
import { loadSourceDefinition } from "../../harnesses/assembly.ts";
import { HARNESS_ENV, SANDBOX_ENV, resolveHarnessSelection } from "../../harnesses/config.ts";
import { openServing } from "../../harnesses/serving.ts";
import { INSTANCE_NAME_ENV } from "../../instance-name.ts";
import { INSTANCE_ROOT_ENV } from "../../paths.ts";
import { decodeRuntimeCliEnv } from "../../process-env.ts";
import { DEFAULT_HTTP_PORT, serveAgent } from "../../service.ts";
import { failStartup, failUsage } from "../fail.ts";
import { ownerKey } from "../owner.ts";
import { cliMountOptions, parseBind, parsePort, serveService } from "../serve.ts";
import { type EnteredInstance, type InstanceFlags, instanceInputs } from "../instance.ts";
import { enterAgentCommand, reportAssembly } from "../shared.ts";

/**
 * `dev` binds loopback unless `--bind` says otherwise: a dev serve carries the agent's full tool authority and lands on
 * networks its author does not own. `--bind 0.0.0.0` gives back the reach a container or a phone needs.
 */
const DEV_BIND = "127.0.0.1";

export interface DevOptions {
  port?: string;
  bind?: string;
  model?: string;
  harness?: string;
  sandbox?: string;
  /** false ⇔ `--no-watch`. */
  watch?: boolean;
  /** false ⇔ `--no-input`. */
  input?: boolean;
  instance?: InstanceFlags;
}

export async function runDev(dirArg: string, opts: DevOptions): Promise<void> {
  setLogLevel("debug"); // dev posture: verbose, includes the debug turn trace (content) — supervisor and worker both
  markDevServe(); // the worker inherits this mark
  const isWorker = decodeRuntimeCliEnv().devWorker;
  let instanceBusy: (() => boolean) | undefined;
  // First, so a restart asked for while the worker is still assembling is heard: with nothing running it stops at once.
  if (isWorker)
    process.on(
      "message",
      listenForRestart(() => process.kill(process.pid, "SIGTERM"), {
        busy: () => (instanceBusy?.() ? 1 : 0),
      }),
    );
  // The model is picked ONCE, in the parent process (a TTY; watch and --no-watch both).
  const { agentDir, modelSpec, instance } = await enterAgentCommand(dirArg, {
    ...opts,
    input: isWorker ? false : opts.input,
  });
  if (isWorker || opts.watch === false) {
    await serveOnce(agentDir, modelSpec, instance, opts, (busy) => {
      instanceBusy = busy;
    });
    return;
  }
  // Flag-shape checks before spawning.
  parsePort(opts.port, "--port", "flag");
  parseBind(opts.bind);
  if (opts.harness !== undefined || opts.sandbox !== undefined) {
    const def = await loadSourceDefinition(agentDir).catch(failStartup);
    try {
      resolveHarnessSelection(
        def.config,
        {
          ...(opts.harness === undefined ? {} : { harness: opts.harness }),
          ...(opts.sandbox === undefined ? {} : { sandbox: opts.sandbox }),
        },
        instance.env,
      );
    } catch (error) {
      failUsage(error instanceof Error ? error.message : String(error));
    }
  }
  await runDevSupervisor(agentDir, {
    FASTAGENT_MODEL: modelSpec,
    ...(instance.root === undefined ? {} : { [INSTANCE_ROOT_ENV]: instance.root }),
    ...(instance.name === undefined ? {} : { [INSTANCE_NAME_ENV]: instance.name }),
    ...(opts.harness === undefined ? {} : { [HARNESS_ENV]: opts.harness }),
    ...(opts.sandbox === undefined ? {} : { [SANDBOX_ENV]: opts.sandbox }),
  });
}

/** Assemble the agent and serve it once (the dev worker; also the --no-watch path). */
async function serveOnce(
  agentDir: string,
  modelSpec: string,
  instance: EnteredInstance,
  opts: DevOptions,
  onOpened?: (busy: () => boolean) => void,
): Promise<void> {
  const portFlag = parsePort(opts.port, "--port", "flag");
  const host = parseBind(opts.bind) ?? DEV_BIND;
  const opened = await loadSourceDefinition(agentDir)
    .then((definition) => {
      const selection = resolveHarnessSelection(
        definition.config,
        {
          ...(opts.harness === undefined ? {} : { harness: opts.harness }),
          ...(opts.sandbox === undefined ? {} : { sandbox: opts.sandbox }),
        },
        instance.env,
      );
      return openServing(definition, {
        model: modelSpec,
        harness: selection.harness,
        ...(selection.sandbox === undefined ? {} : { sandbox: selection.sandbox }),
        ...instanceInputs(agentDir, { instance }),
      });
    })
    .catch(failStartup);
  onOpened?.(() => opened.busy());
  await reportAssembly(opened, modelSpec);
  // This machine's other commands reach the instance through the serve that owns it (owner.ts).
  const key = ownerKey();
  const mount = cliMountOptions();
  const service = await serveAgent(opened, { ...mount, apiKeys: [...(mount.apiKeys ?? []), key] }).catch(failStartup);
  serveService(service, { port: portFlag ?? DEFAULT_HTTP_PORT, host }, { stateRoot: opened.stateRoot, key });
}
