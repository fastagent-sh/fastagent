/** Production serving. */
import { join, resolve } from "node:path";
import type { Agent } from "../../agent-api.ts";
import { applyRuntimeSecrets } from "../../deploy/agentcore/runtime-secrets.ts";
import { prepareDeployment, releaseFromEnv } from "../../deploy/workspace.ts";
import {
  selectAgentEnvironment,
  resolveSecretsDir,
  isAgentcoreRuntime,
  isDeployedWorkspace,
  isUnderDir,
  INSTANCE_ROOT_ENV,
} from "../../paths.ts";
import { log, setLogLevel } from "../../log.ts";
import { loadProjectBuild } from "../../harnesses/pi-durable/built.ts";
import type { Project } from "../../harnesses/pi-durable/open.ts";
import type { EffectiveConfig } from "../../harnesses/pi-durable/config.ts";
import { namedInstanceConfig } from "../../harnesses/pi-durable/config.ts";
import { openServing } from "../../harnesses/pi-durable/serve.ts";
import { type InstanceFlags, instanceInputs } from "../instance.ts";
import { DEFAULT_HTTP_PORT, serveAgent, type ServedAgent } from "../../service.ts";
import { mountAgentcoreService, deferAgentcoreService } from "../../channels/agentcore-service.ts";
import { failStartup } from "../fail.ts";
import { unmarkDevServe } from "../../serving-command.ts";
import { assertTunnelBindable, bindLine, cliMountOptions, serveService, serve } from "../serve.ts";
import { enterAgentCommand, parseBind, parsePort, reportAssembly } from "../shared.ts";

export interface StartOptions {
  port?: string;
  bind?: string;
  model?: string;
  tunnel?: boolean;
  input?: boolean;
  instance?: InstanceFlags;
}

/** What `start` opened and serves: the agent too, for a deployment's own check of what it runs. */
type StartedService = ServedAgent & { agent: Agent; stateRoot: string; port: number; config: EffectiveConfig };

export async function runStart(dirArg: string, opts: StartOptions): Promise<void> {
  const portFlag = parsePort(opts.port, "--port", "flag");
  const bindFlag = parseBind(opts.bind);
  setLogLevel("info");
  selectAgentEnvironment("production");
  unmarkDevServe();
  if (isAgentcoreRuntime()) {
    // The generated Runtime resource sets PORT; 8080 is the platform's contract when nothing does.
    const port = portFlag ?? parsePort(process.env.PORT, "PORT env", "env") ?? 8080;
    const deferred = deferAgentcoreService({
      prepare: () => prepareAgentcoreWorkspace(dirArg),
      assemble: async (dir) => {
        const service = await openPreparedStartService(dir, opts);
        await service.ready;
        return service;
      },
    });
    // The assembly report waits for the first envelope, so this line is the only sign of life a booted container gives.
    serve(deferred, { port, host: bindFlag }, (port) => {
      log.info(bindLine(bindFlag, port));
      log.info("[fastagent] agentcore: the definition opens on the first invocation");
    });
    return;
  }
  // Deployed storage refusals (no mount, a held lease, a missing `flock`, another agent's storage) are the operator's only
  // clue in a crash-looping container.
  const service = await openStartService(dirArg, opts).catch(failStartup);
  const tunnel = opts.tunnel ?? false;
  // An unset bind stays the wildcard: this is the container posture, and a published port needs it.
  assertTunnelBindable(bindFlag, tunnel);
  serveService(
    service,
    { port: portFlag ?? parsePort(process.env.PORT, "PORT env", "env") ?? service.port, host: bindFlag },
    { tunnel, agentDir: service.agentDir, config: service.config },
  );
}

/**
 * Stage one — TAKE the storage, on a deployed box (a release id names it): it is mounted, held by this process,
 * and this agent's; it becomes the instance's root, and the machinery points at it. The program stays where the image
 * built it, `dirArg`. Returns that directory. Elsewhere, nothing is taken.
 */
export async function prepareStartWorkspace(dirArg: string): Promise<string> {
  if (!isDeployedWorkspace()) return dirArg;
  const storage = process.env[INSTANCE_ROOT_ENV];
  if (!storage) throw new Error(`${INSTANCE_ROOT_ENV} is required for a deployment`);
  const root = resolve(storage);
  await prepareDeployment(root, releaseFromEnv());
  process.env[INSTANCE_ROOT_ENV] = root;
  // Defaults, not overrides: an operator who pointed a directory somewhere else meant it, and silently relocating
  // their state is the one failure they could not diagnose from the logs.
  process.env.FASTAGENT_STATE_DIR ||= join(root, ".state");
  process.env.FASTAGENT_SECRETS_DIR ||= join(root, ".secrets");
  // mise's data directory, on the storage rather than the container's disk. The image's packages are in mise's system
  // directory, which mise reads as well, so a start installs nothing there.
  process.env.MISE_DATA_DIR ||= join(process.env.FASTAGENT_STATE_DIR, "mise");
  return dirArg;
}

/**
 * AgentCore's stage one: the deployment's values first, on the first invocation, so a failed read is that invocation's
 * failure and the next asks again; then the storage.
 */
export async function prepareAgentcoreWorkspace(dirArg: string): Promise<string> {
  await applyRuntimeSecrets();
  return prepareStartWorkspace(dirArg);
}

export async function openStartService(dirArg: string, opts: StartOptions): Promise<StartedService> {
  return openPreparedStartService(await prepareStartWorkspace(dirArg), opts);
}

/** Stage two: open the built definition in `dirArg` and serve it. */
export async function openPreparedStartService(dirArg: string, opts: StartOptions): Promise<StartedService> {
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
    // AgentCore's session storage refuses SQLite's own locks; the deployment's lease makes the dotfile lock safe.
    storage: { instance: isAgentcoreRuntime() ? "leased-dotfile" : "posix" },
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
  const service = await (isAgentcoreRuntime()
    ? mountAgentcoreService(opened)
    : serveAgent(opened, cliMountOptions(effective)));
  return {
    ...service,
    agent: opened.agent,
    stateRoot,
    port: effective.http?.port ?? DEFAULT_HTTP_PORT,
    config: effective,
  };
}
