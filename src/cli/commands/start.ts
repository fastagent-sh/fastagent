/** Production serving. */
import { join, resolve } from "node:path";
import type { Agent } from "../../agent-api.ts";
import { prepareDeployment, releaseFromEnv } from "../../deploy/workspace.ts";
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
import { DEFAULT_HTTP_PORT, type ServableAgent, serveAgent, type ServedAgent } from "../../service.ts";
import { failStartup } from "../fail.ts";
import { unmarkDevServe } from "../../serving-command.ts";
import { assertTunnelBindable, bindLine, cliMountOptions, serve, serveService } from "../serve.ts";
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
export type StartedService = ServedAgent & { agent: Agent; stateRoot: string; port: number; config: EffectiveConfig };

export async function runStart(dirArg: string, opts: StartOptions): Promise<void> {
  const portFlag = parsePort(opts.port, "--port", "flag");
  const bindFlag = parseBind(opts.bind);
  setLogLevel("info");
  selectAgentEnvironment("production");
  unmarkDevServe();
  if (process.env.FASTAGENT_AGENTCORE === "1") {
    const { runAgentcoreStart } = await import("../../deploy/agentcore/start.ts");
    runAgentcoreStart(
      {
        prepareWorkspace: () => prepareStartWorkspace(dirArg),
        openPrepared: (dir, runtime) => openPreparedStartService(dir, opts, runtime),
        serve,
        bindLine,
        parsePort,
      },
      {
        ...(portFlag === undefined ? {} : { portFlag }),
        ...(bindFlag === undefined ? {} : { bindFlag }),
      },
    );
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
  return dirArg;
}

export async function openStartService(dirArg: string, opts: StartOptions): Promise<StartedService> {
  return openPreparedStartService(await prepareStartWorkspace(dirArg), opts);
}

/** Stage two: open the built definition in `dirArg` and serve it. */
export async function openPreparedStartService(
  dirArg: string,
  opts: StartOptions,
  runtime: {
    storage?: "posix" | "leased-dotfile";
    mount?: (opened: ServableAgent) => Promise<ServedAgent>;
  } = {},
): Promise<StartedService> {
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
    storage: { instance: runtime.storage ?? "posix" },
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
  const service = await (runtime.mount ? runtime.mount(opened) : serveAgent(opened, cliMountOptions(effective)));
  return {
    ...service,
    agent: opened.agent,
    stateRoot,
    port: effective.http?.port ?? DEFAULT_HTTP_PORT,
    config: effective,
  };
}
