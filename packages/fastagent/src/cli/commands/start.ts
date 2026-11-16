/** Production serving. */
import { resolve } from "node:path";
import type { Agent } from "@fastagent-sh/client/agent-api";
import { prepareDeployment, storageOwnerFromEnv } from "../../deploy/workspace.ts";
import { selectAgentEnvironment, isDeployedWorkspace, isUnderDir, INSTANCE_ROOT_ENV } from "../../paths.ts";
import { log, setLogLevel } from "@fastagent-sh/client/log";
import { loadProjectBuild } from "../../harnesses/pi-durable/built.ts";
import type { AgentDefinition } from "../../harnesses/pi-durable/definition.ts";
import { openServing } from "../../harnesses/pi-durable/serve.ts";
import { type InstanceFlags, instanceInputs } from "../instance.ts";
import { DEFAULT_HTTP_PORT, serveAgent, type ServedAgent } from "../../service.ts";
import { failStartup } from "../fail.ts";
import { unmarkDevServe } from "../../serving-command.ts";
import { cliMountOptions, serveService } from "../serve.ts";
import { enterAgentCommand, parseBind, parsePort, reportAssembly } from "../shared.ts";

export interface StartOptions {
  port?: string;
  bind?: string;
  model?: string;
  input?: boolean;
  instance?: InstanceFlags;
}

/** What `start` opened and serves. */
type StartedService = ServedAgent & { agent: Agent; stateRoot: string };

export async function runStart(dirArg: string, opts: StartOptions): Promise<void> {
  const portFlag = parsePort(opts.port, "--port", "flag");
  const bindFlag = parseBind(opts.bind);
  setLogLevel("info");
  selectAgentEnvironment("production");
  unmarkDevServe();
  // Deployed storage refusals (no mount, a held lease, a missing `flock`, another agent's storage) are the operator's only
  // clue in a crash-looping container.
  const service = await openStartService(dirArg, opts).catch(failStartup);
  // An unset bind stays the wildcard: this is the container posture, and a published port needs it.
  serveService(service, {
    port: portFlag ?? parsePort(process.env.PORT, "PORT env", "env") ?? DEFAULT_HTTP_PORT,
    host: bindFlag,
  });
}

/**
 * On a deployed box (the generated image marks it), TAKE the storage: it is mounted, held by this process, and this agent's;
 * it becomes the instance's root, and the machinery points at it. The program stays where the image built it. Elsewhere,
 * nothing is taken.
 */
async function prepareStartWorkspace(): Promise<void> {
  if (!isDeployedWorkspace()) return;
  const storage = process.env[INSTANCE_ROOT_ENV];
  if (!storage) throw new Error(`${INSTANCE_ROOT_ENV} is required for a deployment`);
  const root = resolve(storage);
  await prepareDeployment(root, storageOwnerFromEnv());
  process.env[INSTANCE_ROOT_ENV] = root;
}

/** Take the storage on a deployed box, then open the built definition in `dirArg` and serve it. */
async function openStartService(dirArg: string, opts: StartOptions): Promise<StartedService> {
  await prepareStartWorkspace();
  // The build, never the source: refused when there is none or the project has moved on.
  let built: Promise<AgentDefinition> | undefined;
  const loadBuilt = (dir: string) => (built ??= loadProjectBuild(dir, { checkSources: !isDeployedWorkspace() }));
  const { agentDir, modelSpec } = await enterAgentCommand(dirArg, opts, undefined, loadBuilt);
  const opened = await openServing(await loadBuilt(agentDir), { model: modelSpec, ...instanceInputs(agentDir) });
  const { stateRoot } = opened;
  await reportAssembly(opened, modelSpec);
  if (isUnderDir(stateRoot, agentDir)) {
    log.info(
      "[fastagent] note: state lives under the definition; use FASTAGENT_ROOT on persistent storage for deployment.",
    );
  }
  const service = await serveAgent(opened, cliMountOptions());
  return { ...service, agent: opened.agent, stateRoot };
}
