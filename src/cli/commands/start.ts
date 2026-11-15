/** Production serving. */
import { join, resolve } from "node:path";
import type { Agent } from "../../agent-api.ts";
import { prepareDeployment, storageOwnerFromEnv } from "../../deploy/workspace.ts";
import {
  selectAgentEnvironment,
  resolveSecretsDir,
  isDeployedWorkspace,
  isUnderDir,
  INSTANCE_ROOT_ENV,
} from "../../paths.ts";
import { log, setLogLevel } from "../../log.ts";
import { loadProjectBuild } from "../../harnesses/pi-durable/built.ts";
import type { Project } from "../../harnesses/pi-durable/open.ts";
import type { EffectiveConfig } from "../../harnesses/pi-durable/config.ts";
import { openServing } from "../../harnesses/pi-durable/serve.ts";
import { namedInstanceConfig } from "../../harnesses/pi-durable/config.ts";
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
type StartedService = ServedAgent & { agent: Agent; stateRoot: string; port: number; config: EffectiveConfig };

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
  serveService(
    service,
    { port: portFlag ?? parsePort(process.env.PORT, "PORT env", "env") ?? service.port, host: bindFlag },
    service.config,
  );
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
  // Defaults, not overrides: an operator who pointed a directory somewhere else meant it, and silently relocating
  // their state is the one failure they could not diagnose from the logs.
  process.env.FASTAGENT_STATE_DIR ||= join(root, ".state");
  process.env.FASTAGENT_SECRETS_DIR ||= join(root, ".secrets");
}

/** Take the storage on a deployed box, then open the built definition in `dirArg` and serve it. */
async function openStartService(dirArg: string, opts: StartOptions): Promise<StartedService> {
  await prepareStartWorkspace();
  // The build, never the source: refused when there is none or the project has moved on.
  let built: Promise<Project> | undefined;
  // A start never reads the development `fastagent.json`: its instance configuration is the one `--config` names.
  const loadBuilt = (dir: string) =>
    (built ??= loadProjectBuild(dir, { checkSources: !isDeployedWorkspace() }).then((definition) => ({ definition })));
  const { agentDir, modelSpec } = await enterAgentCommand(dirArg, opts, undefined, loadBuilt);
  const config = await namedInstanceConfig();
  const opened = await openServing((await loadBuilt(agentDir)).definition, {
    model: modelSpec,
    ...instanceInputs(agentDir),
    ...(config === undefined ? {} : { config }),
  });
  const { stateRoot } = opened;
  await reportAssembly(opened, modelSpec);
  if (isUnderDir(stateRoot, agentDir)) {
    log.info(
      "[fastagent] note: state lives under the definition; use FASTAGENT_STATE_DIR on persistent storage for deployment.",
    );
  }
  if (isUnderDir(resolveSecretsDir(agentDir), agentDir)) {
    log.info(
      "[fastagent] note: credentials live under the definition; use FASTAGENT_SECRETS_DIR on persistent storage for deployment.",
    );
  }
  const { config: effective } = opened;
  const service = await serveAgent(opened, cliMountOptions(effective));
  return {
    ...service,
    agent: opened.agent,
    stateRoot,
    port: effective.http?.port ?? DEFAULT_HTTP_PORT,
    config: effective,
  };
}
