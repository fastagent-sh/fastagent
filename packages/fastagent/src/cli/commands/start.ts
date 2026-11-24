/** Production serving. */
import { resolve } from "node:path";
import { prepareDeployment, storageOwnerFromEnv } from "../../deploy/workspace.ts";
import { isDeployedWorkspace, isUnderDir, INSTANCE_ROOT_ENV } from "../../paths.ts";
import { decodeRuntimeCliEnv } from "../../process-env.ts";
import { log, setLogLevel } from "../../log.ts";
import { loadProjectBuild } from "../../definition/built.ts";
import type { AgentDefinition } from "../../definition/definition.ts";
import { resolveHarnessSelection } from "../../harnesses/config.ts";
import { openServing } from "../../harnesses/serving.ts";
import { type InstanceFlags, instanceInputs } from "../instance.ts";
import { DEFAULT_HTTP_PORT, serveAgent, type ServedAgent } from "../../service.ts";
import { failStartup, failUsage } from "../fail.ts";
import { unmarkDevServe } from "../../serving-command.ts";
import { cliMountOptions, parseBind, parsePort, serveService } from "../serve.ts";
import { enterAgentCommand, reportAssembly } from "../shared.ts";

export interface StartOptions {
  port?: string;
  bind?: string;
  model?: string;
  harness?: string;
  sandbox?: string;
  input?: boolean;
  instance?: InstanceFlags;
}

export async function runStart(dirArg: string, opts: StartOptions): Promise<void> {
  const portFlag = parsePort(opts.port, "--port", "flag");
  const bindFlag = parseBind(opts.bind);
  setLogLevel("info");
  unmarkDevServe();
  // Deployed storage refusals (no mount, a held lease, a missing `flock`, another agent's storage) are the operator's only
  // clue in a crash-looping container.
  const service = await openStartService(dirArg, opts).catch(failStartup);
  // An unset bind stays the wildcard: this is the container posture, and a published port needs it.
  serveService(service, {
    port: portFlag ?? parsePort(decodeRuntimeCliEnv().port, "PORT env", "env") ?? DEFAULT_HTTP_PORT,
    host: bindFlag,
  });
}

/**
 * On a deployed box (the generated image marks it), TAKE the storage: it is mounted, held by this process, and this agent's;
 * it becomes the instance's root, and the machinery points at it. The program stays where the image built it. Elsewhere,
 * nothing is taken.
 */
async function prepareStartWorkspace(): Promise<string | undefined> {
  if (!isDeployedWorkspace()) return undefined;
  const storage = decodeRuntimeCliEnv().instanceRoot;
  if (!storage) throw new Error(`${INSTANCE_ROOT_ENV} is required for a deployment`);
  const root = resolve(storage);
  await prepareDeployment(root, storageOwnerFromEnv());
  return root;
}

/** Take the storage on a deployed box, then open the built definition in `dirArg` and serve it. */
async function openStartService(dirArg: string, opts: StartOptions): Promise<ServedAgent> {
  const deployedRoot = await prepareStartWorkspace();
  const instanceFlags =
    deployedRoot === undefined ? opts.instance : { ...opts.instance, root: opts.instance?.root ?? deployedRoot };
  // The build, never the source: refused when there is none or the project has moved on.
  let built: Promise<AgentDefinition> | undefined;
  const loadBuilt = (dir: string) => (built ??= loadProjectBuild(dir, { checkSources: !isDeployedWorkspace() }));
  const { agentDir, modelSpec, instance } = await enterAgentCommand(
    dirArg,
    { ...opts, ...(instanceFlags === undefined ? {} : { instance: instanceFlags }) },
    undefined,
    loadBuilt,
  );
  const definition = await loadBuilt(agentDir);
  const selection = (() => {
    try {
      return resolveHarnessSelection(
        definition.config,
        {
          ...(opts.harness === undefined ? {} : { harness: opts.harness }),
          ...(opts.sandbox === undefined ? {} : { sandbox: opts.sandbox }),
        },
        instance.configEnv,
      );
    } catch (error) {
      return failUsage(error instanceof Error ? error.message : String(error));
    }
  })();
  const opened = await openServing(definition, {
    model: modelSpec,
    harness: selection.harness,
    ...(selection.sandbox === undefined ? {} : { sandbox: selection.sandbox }),
    ...instanceInputs(agentDir, { mode: "start", instance }),
  });
  await reportAssembly(opened, modelSpec);
  if (isUnderDir(opened.stateRoot, agentDir)) {
    log.info(
      "[fastagent] note: state lives under the definition; use FASTAGENT_ROOT on persistent storage for deployment.",
    );
  }
  return serveAgent(opened, cliMountOptions());
}
