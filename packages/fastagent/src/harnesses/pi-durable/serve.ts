/**
 * A definition opened: its code built with its secrets, its model environment, its storage, and the Agent over them.
 * `openAgent` is how an app opens one; `dev`, `start`, `invoke` and `schedules run` open it
 * through `openServing`, which also takes where the Agent keeps its sessions and what becomes of an earlier process's
 * messages.
 */
import { dirname, isAbsolute, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Harness, MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import type { CredentialSourceOptions } from "../models/credentials.ts";
import { type ModelEnvironment, modelEnvironment } from "../models/environment.ts";
import { openMcpClients, type McpClients } from "../../mcp/client.ts";
import { declareMcp, resolveMcpServers } from "../../mcp/config.ts";
import { NOT_HOSTED, type RunsAs } from "../../serving-command.ts";
import { mcpTools } from "./mcp.ts";
import { processEnvironment } from "../../child-env.ts";
import { definedValues } from "../../declared-secrets.ts";
import { log } from "../../log.ts";
import type { Agent } from "@fastagent-sh/client/agent-api";
import { DATABASE_URL_ENV, STATE_DIRNAME, resolveStateRoot } from "../../paths.ts";
import { type Service, serveAgent } from "../../service.ts";
import type { DurableAgent, Unfinished } from "./agent.ts";
import type { AgentConfig } from "./define.ts";
import { type AgentDefinition, assertDefinition } from "./definition.ts";
import { type BuiltDefinition, assembleAgent, buildDefinition } from "./open.ts";
import { describeDatabase } from "./postgres/database.ts";
import { openPostgresStorage } from "./postgres/storage.ts";
import { openLockedStorage } from "./storage.ts";
import { INSTANCE_NAME_ENV, instanceName } from "../../instance-name.ts";
import { otlpTraces } from "../telemetry/otlp.ts";
import { fastagentVersion } from "../../version.ts";

export interface OpenServingOptions extends CredentialSourceOptions {
  /** The instance's name. Default: the definition's, as one segment. */
  name?: string;
  /**
   * The values the instance's code, its MCP servers and its model's authentication read by name (`needs`, `${VAR}`,
   * a provider's variable): the one source of them, never this process's environment. A caller that wants its own
   * passes it (`process.env`).
   */
  secrets: Readonly<Record<string, string | undefined>>;
  /**
   * The base environment of the processes the agent starts (`baseEnv(process.env)` is the CLI's), plus the declared
   * secrets. Nothing else of this process's reaches them.
   */
  env: Readonly<Record<string, string>>;
  /**
   * The environment FastAgent's own work for the instance runs in: where a CLI instance's files are, and whether it is
   * offline. The CLI gives this process's; an app, its `env`. The instance's secrets are added to it.
   */
  ownEnv: Readonly<Record<string, string | undefined>>;
  /** Who runs the instance: whether its prompt describes a deployment. */
  runsAs: RunsAs;
  /** Whether the model lists are refreshed without the network. Default: `ownEnv`'s `FASTAGENT_OFFLINE` is `1`. */
  offline?: boolean;
  /** What a deployment sets over the definition's model (a flag, `FASTAGENT_MODEL`). */
  model?: string;
  /**
   * Where the Agent keeps its sessions. Default `"instance"`: the instance's `agent.sqlite`, or the PostgreSQL database
   * `FASTAGENT_DATABASE_URL` names (postgres/storage.ts), which one process holds at a time, with `wake` and `unwake`,
   * since a serve's clock fires the wake-ups they keep. The other
   * two never meet the storage a serve of the same directory holds, and have no `wake`, since no clock fires for them:
   * `{ file }` is a database of the caller's own, held the same way (`holders`, when given, names in the refusal of a
   * second opener what else opens it), and `"memory"` keeps nothing.
   */
  storage?: ServingStorage;
  /** What becomes of the messages an earlier process left unfinished in the storage. Default `"resume"`. */
  unfinished?: Unfinished;
  /**
   * The instance's directory: its working directory, where its secrets and, by default, its state are. Default: the
   * definition's own, which is how a source project runs. A built package is read-only and is opened with a directory
   * of its own.
   */
  workdir?: string;
  /**
   * The directory whose `.secrets/` (values, model credentials) and default state
   * root the instance reads. Default: the working directory.
   */
  projectDir?: string;
  /** The instance's state root. Default: the project directory's own (`resolveStateRoot`). */
  stateRoot?: string;
  /**
   * Where the instance keeps its model credentials when it is given no store: `"secrets"`, the project's `.secrets/`
   * over the machine's own credentials (the CLI's), or `"state"`, `auth.json` in the state root and nothing else (an
   * app's).
   * Default `"secrets"`.
   */
  keeps?: "secrets" | "state";
  /** Whether a clock fires the instance's wake-ups now (`assembleAgent`'s `wakeTicking`). Default always. */
  wakeTicking?: () => boolean;
}

type ServingStorage = "instance" | { file: string; holders?: string } | "memory";

/** Who opens the instance's storage, for the refusal of a second opener. */
const INSTANCE_HOLDERS =
  "another `fastagent dev`, `start` or `schedules` command of this agent (or of another agent with the same state root)";
/** Who opens an instance in a database: any process, on any machine, of an instance of that name. */
const NAMED_INSTANCE_HOLDERS =
  "another `fastagent dev`, `start` or `schedules` command of an instance of this name, on this machine or another";

export interface OpenedServing {
  agent: DurableAgent;
  definition: AgentDefinition;
  /** The instance's name: what `info().name` reports. */
  name: string;
  code: BuiltDefinition;
  /** The definition's configuration (`fastagent.config.ts`). */
  config: AgentConfig;
  /** The secrets it was given that hold a value: what its code was built with. */
  secrets: Readonly<Record<string, string>>;
  models: ModelEnvironment;
  /** The project directory: whose `.secrets/` the instance reads. */
  agentDir: string;
  /** The agent's working directory. */
  workdir: string;
  /** Where the instance's state is: its storage, its schedules' state, its wake-ups. */
  stateRoot: string;
  /** The definition's schedules, as `serveAgent` serves them: `serveAgent(opened)`. */
  schedules: BuiltDefinition["schedules"];
}

/** What decides where an instance's storage is: its state root, or a database several instances share. */
export interface InstancePlace {
  stateRoot: string;
  env: Readonly<Record<string, string | undefined>>;
  /** The name it was given, which opens it in a database: never a default there. */
  name?: string;
  /** The agent it runs (its package's name), which an instance in a database belongs to. */
  agent?: string;
}

/** Where the instance's storage is, as a person reads it: the database (without credentials), or the file. */
export function describeInstanceStorage(place: InstancePlace): string {
  const url = place.env[DATABASE_URL_ENV];
  if (!url) return join(place.stateRoot, "agent.sqlite");
  const instance = place.name === undefined ? `no instance: set ${INSTANCE_NAME_ENV}` : `instance "${place.name}"`;
  return `PostgreSQL ${describeDatabase(url)}, ${instance}`;
}

/**
 * The instance's storage, which one process holds at a time: `agent.sqlite` under its state root, or its database's,
 * whose hold can end while open (`onLost`).
 */
function openInstanceStorage(place: InstancePlace, onLost?: (error: Error) => void): Promise<Storage> {
  const url = place.env[DATABASE_URL_ENV];
  if (url) {
    if (place.name === undefined) {
      return Promise.reject(
        new Error(
          `${DATABASE_URL_ENV}: an instance in a database is opened by its name, and none was given: ` +
            `set ${INSTANCE_NAME_ENV} (an app: openAgent's name)`,
        ),
      );
    }
    return openPostgresStorage(url, place.name, {
      holders: NAMED_INSTANCE_HOLDERS,
      ...(place.agent === undefined ? {} : { agent: place.agent }),
      ...(onLost === undefined ? {} : { onLost }),
    });
  }
  return openLockedStorage(join(place.stateRoot, "agent.sqlite"), INSTANCE_HOLDERS);
}

/**
 * Run `work` holding the instance's storage, so no serve of the instance runs meanwhile: how a command changes the
 * instance's state outside a serve without losing a write to a serve's own.
 */
export async function holdingInstance<T>(place: InstancePlace, work: () => T): Promise<T> {
  const storage = await openInstanceStorage(place);
  try {
    return await work();
  } finally {
    await storage.close(BACKGROUND_CONTEXT);
  }
}

function openStorage(
  place: InstancePlace,
  storage: ServingStorage,
  onLost: (error: Error) => void,
): Promise<Storage> | Storage {
  if (storage === "memory") return new MemoryStorage();
  if (storage === "instance") return openInstanceStorage(place, onLost);
  return openLockedStorage(storage.file, storage.holders);
}

export async function openServing(definition: AgentDefinition, options: OpenServingOptions): Promise<OpenedServing> {
  const { dir } = definition;
  const workdir = options.workdir ?? dir;
  const projectDir = options.projectDir ?? workdir;
  const { config } = definition;
  const name = instanceName(definition.name, options.name);
  const mcpServers = declareMcp(config.mcpServers, dir);
  // The instance's values are ONE input every reader below is given, and this process's is never written: a process
  // may run several agents, each with its own values.
  const secrets = definedValues(options.secrets);
  const code = buildDefinition(definition, secrets);
  // FastAgent's own work for the instance (finding its files) runs in this process's environment and the instance's
  // secrets. What the AGENT starts gets an environment assembled from inputs.
  const env = { ...options.ownEnv, ...secrets };
  const processEnv = processEnvironment(
    {
      base: options.env,
      secrets,
      declared: definition.inputs.secrets.map(({ name }) => name),
      workdir,
    },
    dirname(workdir),
  );
  const stateRoot = options.stateRoot ?? resolveStateRoot(projectDir, env);
  const authPath =
    options.authPath ??
    (options.keeps === "state" && options.credentialStore === undefined ? join(stateRoot, "auth.json") : undefined);
  const models = await modelEnvironment(
    projectDir,
    {
      ...(authPath === undefined ? {} : { authPath }),
      ...(options.credentialStore === undefined ? {} : { credentialStore: options.credentialStore }),
    },
    code.providers,
    { stateRoot, environment: secrets, env, offline: options.offline ?? env.FASTAGENT_OFFLINE === "1" },
  );
  // Before anything is opened: a setting it cannot honor refuses the open.
  const traces = otlpTraces(env, { serviceName: name, serviceVersion: await fastagentVersion() });
  const chosen = options.storage ?? "instance";
  const place: InstancePlace = {
    stateRoot,
    env,
    agent: definition.name,
    ...(options.name === undefined ? {} : { name }),
  };
  // Before the agent exists, a lost hold fails its open's first commit instead.
  let stopRuns: ((error: Error) => void) | undefined;
  const storage = await openStorage(place, chosen, (error) => stopRuns?.(error));
  if (chosen === "instance" && env[DATABASE_URL_ENV])
    log.info(`[fastagent] storage: ${describeInstanceStorage(place)}`);
  let mcp: McpClients | undefined;
  let agent: DurableAgent;
  try {
    mcp = await openMcpClients(resolveMcpServers(mcpServers, secrets, undefined, workdir, processEnv));
    agent = await assembleAgent(definition, {
      name,
      mcpTools: mcpTools(mcp.tools),
      runsAs: options.runsAs,
      storage,
      code,
      workdir,
      processEnv,
      models: models.models,
      ...(models.catalogProblem === undefined ? {} : { catalogProblem: models.catalogProblem }),
      ...(chosen === "instance" ? { stateRoot } : {}),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.unfinished === undefined ? {} : { unfinished: options.unfinished }),
      ...(options.wakeTicking === undefined ? {} : { wakeTicking: options.wakeTicking }),
      ...(traces === undefined ? {} : { telemetry: traces.context }),
    });
  } catch (error) {
    const failures: unknown[] = [error];
    if (mcp) await mcp.close().catch((cleanup: unknown) => failures.push(cleanup));
    await storage.close(BACKGROUND_CONTEXT).catch((cleanup: unknown) => failures.push(cleanup));
    await traces?.close();
    throw failures.length === 1 ? error : new AggregateError(failures, "Agent open and cleanup failed");
  }
  // No longer the instance's holder: its runs stop before another process may resume them.
  stopRuns = (error) => {
    log.error(`[fastagent] ${error.message}: stopping its runs`);
    agent.harness
      .close(BACKGROUND_CONTEXT)
      .catch((cause: unknown) => log.warn(`[fastagent] stopping the runs failed: ${String(cause)}`));
  };
  // A storage failure or a direct harness close also ends the resources this open acquired.
  void agent.harness.closed
    .then(() => mcp.close())
    .catch((error: unknown) => {
      log.warn(`[fastagent] MCP cleanup after harness shutdown failed: ${String(error)}`);
    })
    .finally(() => traces?.close());
  const closeAgent = agent.close.bind(agent);
  let closing: Promise<void> | undefined;
  agent.close = () =>
    (closing ??= (async () => {
      const failures: unknown[] = [];
      await closeAgent().catch((error: unknown) => failures.push(error));
      await mcp.close().catch((error: unknown) => failures.push(error));
      // Last: what the agent recorded up to its close goes out with it.
      await traces?.close();
      if (failures.length) throw new AggregateError(failures, "Agent close failed");
    })());
  return {
    agent,
    definition,
    name,
    code,
    config,
    secrets,
    models,
    agentDir: projectDir,
    workdir,
    stateRoot,
    schedules: code.schedules,
  };
}

/** An agent opened in this process: the Agent API, and how it is served and operated. */
export interface LocalAgent extends Agent {
  /**
   * Schedules and wake-ups, `/health`, and the Agent API under `/v1` when `apiKeys` holds a key: a Fetch
   * handler, or a server of its own (`listen`).
   */
  serve(options?: ServeAgentOptions): Promise<Service>;
  /** pi-durable's own API, for operating the agent. */
  readonly harness: Harness;
  /** Close what `serve` started, then release the instance's storage. */
  close(): Promise<void>;
}

export interface ServeAgentOptions {
  /** The keys a Caller of the Agent API may present. */
  apiKeys?: readonly string[];
}

export interface OpenAgentOptions {
  /** The instance root, absolute: the agent's working directory, with its state in `<root>/.state`. */
  root: string;
  /** The instance's name: one path segment. Default: the definition's, as one. */
  name?: string;
  /**
   * The values the agent's code (`needs`), its MCP servers (`${VAR}`) and its model's authentication read by name. The
   * only source of them: nothing is read from the process's environment or from a file, so pass what the agent needs
   * (`process.env` is a choice an app can make).
   */
  secrets?: Readonly<Record<string, string | undefined>>;
  /**
   * The base environment of the processes the agent starts (its commands, stdio MCP servers, skill scripts). Default:
   * empty; `baseEnv(process.env)` is an app's own. The commands of the agent's declared packages come ahead on its
   * `PATH`, and the secrets the definition declares are added; nothing else of the host's reaches them.
   */
  env?: Readonly<Record<string, string>>;
  /** `"provider/modelId"`, over the definition's: what a session that names none answers with. */
  model?: string;
  /** Refresh the model lists without the network: each is the one last kept, or pi-ai's own. Default: false. */
  offline?: boolean;
}

/** The instance root, which must be absolute: a relative one would be an input the process's cwd chooses. */
function locationOf({ root }: { root: unknown }): { workdir: string; stateRoot: string } {
  if (typeof root !== "string" || !isAbsolute(root)) {
    throw new Error(`root must be an absolute path, and is ${JSON.stringify(root)}`);
  }
  return { workdir: root, stateRoot: join(root, STATE_DIRNAME) };
}

/**
 * Open one instance of `definition`, the default export of an agent's package, the way `dev` and `start` do before they
 * serve: its code built with the secrets it declares, its environment and the instance's storage, which
 * one process holds at a time. Nothing reaches the agent until `serve`.
 */
export async function openAgent(definition: AgentDefinition, options: OpenAgentOptions): Promise<LocalAgent> {
  const { workdir, stateRoot } = locationOf(options);
  // An app may never serve the agent, and then no clock fires a wake-up: `wake` is refused until it does.
  let ticking = false;
  const opened = await openServing(assertDefinition(definition), {
    workdir,
    stateRoot,
    secrets: options.secrets ?? {},
    env: options.env ?? {},
    ownEnv: options.env ?? {},
    runsAs: NOT_HOSTED,
    offline: options.offline === true,
    ...(options.name === undefined ? {} : { name: options.name }),
    wakeTicking: () => ticking,
    keeps: "state",
    ...(options.model === undefined ? {} : { model: options.model }),
  });
  const { agent } = opened;
  let served: Promise<Service> | undefined;
  let closing: Promise<void> | undefined;
  return {
    info: agent.info,
    usage: agent.usage,
    sessions: agent.sessions,
    messages: agent.messages,
    schedules: agent.schedules,
    wakeups: agent.wakeups,
    harness: agent.harness,
    serve(serveOptions = {}) {
      // Its storage is let go, or about to be: a service now would run schedules nobody closes.
      if (closing !== undefined) return Promise.reject(new Error("this agent is closed"));
      if (served !== undefined) return Promise.reject(new Error("this agent is already served"));
      const serving = serveAgent(opened, serveOptions).then(
        (service): Service => ({
          ...service,
          close: () => {
            // Its clock stops with it, whichever closes it: a wake-up kept after this is one nothing fires.
            ticking = false;
            return service.close();
          },
        }),
      );
      served = serving;
      serving.then(
        () => {
          if (served === serving && closing === undefined) ticking = true;
        },
        // A serve that failed to start rolled itself back, so the agent may be served again.
        () => {
          if (served === serving) served = undefined;
        },
      );
      return serving;
    },
    close() {
      closing ??= (async () => {
        // A serve that never started has nothing to close; its failure reached the caller of `serve`.
        const service = await served?.catch(() => undefined);
        const failures: unknown[] = [];
        await service?.close().catch((error: unknown) => failures.push(error));
        await agent.close().catch((error: unknown) => failures.push(error));
        if (failures.length > 0) {
          throw failures.length === 1 ? failures[0] : new AggregateError(failures, "the agent did not close cleanly");
        }
      })();
      return closing;
    },
  };
}
