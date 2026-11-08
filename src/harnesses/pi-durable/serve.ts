/**
 * A definition opened: its code built with its secrets, its model environment, its storage, and the Agent over them.
 * `openAgent` is how an app opens one (SPEC.md §8); `dev`, `start`, AgentCore, `invoke` and `schedules run` open it
 * through `openServing`, which also takes where the Agent keeps its sessions and what becomes of an earlier process's
 * messages.
 */
import { dirname, isAbsolute, join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Harness, MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import type { CredentialSourceOptions } from "../models/credentials.ts";
import { type ModelEnvironment, modelEnvironment } from "../models/environment.ts";
import { piCredentials } from "../models/host.ts";
import type { CredentialStore } from "../../sign-in-api.ts";
import type { McpOptions } from "../../mcp-api.ts";
import { openMcpClients, type McpClients } from "../../mcp/client.ts";
import { declareMcp, resolveMcpServers } from "../../mcp/config.ts";
import { mcpAuthorization, mcpAuthorizationInState } from "../../mcp/host.ts";
import { servedByDev } from "../../serving-command.ts";
import { mcpTools } from "./mcp.ts";
import { loadContent } from "../../content/file.ts";
import { type ResolvedContent, cloneContent, resolveContent } from "../../content/resolve.ts";
import { processEnvironment } from "../../child-env.ts";
import { definedValues } from "../../declared-secrets.ts";
import { prepareEnvironment } from "../../environment/mise.ts";
import { log } from "../../log.ts";
import type { Agent } from "../../agent-api.ts";
import { STATE_DIRNAME, resolveStateRoot } from "../../paths.ts";
import { type Service, serveAgent } from "../../service.ts";
import type { DurableAgent, Unfinished } from "./agent.ts";
import {
  type EffectiveConfig,
  type InstanceConfig,
  type InstanceConfigSource,
  readInstanceConfigFile,
  resolveConfig,
} from "./config.ts";
import { type AgentDefinition, assertDefinition } from "./definition.ts";
import { type BuiltDefinition, assembleAgent, buildDefinition } from "./open.ts";
import { type StorageLocking, openLockedStorage } from "./storage.ts";
import { openText } from "./text.ts";
import { instanceName } from "../../instance-name.ts";

export interface OpenServingOptions extends CredentialSourceOptions {
  mcp?: McpOptions;
  /** The instance's name, over the configuration's. Default: the configuration's, else the definition's as one segment. */
  name?: string;
  /**
   * The values the instance's code, its MCP servers and its model's authentication read by name (`needs`, `${VAR}`,
   * a provider's variable): the one source of them, never this process's environment. A caller that wants its own
   * passes it (`process.env`).
   */
  secrets: Readonly<Record<string, string | undefined>>;
  /**
   * The base environment of the processes the agent starts (`baseEnv(process.env)` is the CLI's): the commands of
   * its declared packages come ahead on its `PATH`, and the declared secrets are added to it. Nothing else of this
   * process's reaches them.
   */
  env: Readonly<Record<string, string>>;
  /**
   * The environment FastAgent's own work for the instance runs in: installing the declared packages, cloning content,
   * finding `git` and `mise`, and where a CLI instance's files are. The CLI gives this process's; an app, its `env`.
   * The instance's secrets are added to it.
   */
  ownEnv: Readonly<Record<string, string | undefined>>;
  /** Whether the model lists are refreshed without the network. Default: `ownEnv`'s `FASTAGENT_OFFLINE` is `1`. */
  offline?: boolean;
  /** What the instance sets over the program's defaults (`fastagent.json`, or an object); none runs on the defaults. */
  config?: InstanceConfigSource;
  /** What a deployment sets over the definition's defaults (a flag, `FASTAGENT_MODEL`). */
  model?: string;
  thinkingLevel?: ModelThinkingLevel;
  /**
   * Where the Agent keeps its sessions. Default `{ instance: "posix" }`: the instance's `agent.sqlite`, which one process
   * holds at a time (storage.ts), with `wake` and `unwake`, since a serve's clock fires the wake-ups they keep. The other
   * two never meet the storage a serve of the same directory holds, and have no `wake`, since no clock fires for them:
   * `{ file }` is a database of the caller's own, held the same way (`holders`, when given, names in the refusal of a
   * second opener what else opens it), and `"memory"` keeps nothing.
   */
  storage?: ServingStorage;
  /** What becomes of the messages an earlier process left unfinished in the storage. Default `"resume"`. */
  unfinished?: Unfinished;
  /**
   * The instance's directory: its working directory, where its content is cloned, its secrets and, by default, its
   * state are. Default: the definition's own, which is how a source project runs. A built package is read-only and is
   * opened with a directory of its own.
   */
  workdir?: string;
  /**
   * The directory whose `.secrets/` (values, model credentials, MCP grants) and default state
   * root the instance reads. Default: the working directory. Temporary: secrets and content become inputs of their own.
   */
  projectDir?: string;
  /** The instance's state root, over `FASTAGENT_STATE_DIR` and the project directory's own. */
  stateRoot?: string;
  /**
   * Where the instance keeps its model credentials and MCP grants when it is given no store: `"secrets"`, the project's
   * `.secrets/` over the machine's own credentials and as `FASTAGENT_AUTH_PATH` and `FASTAGENT_SECRETS_DIR` place them
   * (the CLI's), or `"state"`, `auth.json` and `mcp-auth.json` in the state root and nothing else (an app's).
   * Default `"secrets"`.
   */
  keeps?: "secrets" | "state";
  /** Whether a clock fires the instance's wake-ups now (`assembleAgent`'s `wakeTicking`). Default always. */
  wakeTicking?: () => boolean;
}

type ServingStorage = { instance: StorageLocking } | { file: string; holders?: string } | "memory";

/** Who opens the instance's storage, for the refusal of a second opener. */
const INSTANCE_HOLDERS =
  "another `fastagent dev`, `start` or `schedules` command of this agent (or of another agent with the same state root)";

export interface OpenedServing {
  agent: DurableAgent;
  definition: AgentDefinition;
  /** The instance's name: what `info().name` reports. */
  name: string;
  code: BuiltDefinition;
  /** The configuration this instance opened with: the program's defaults and the instance's over them. */
  config: EffectiveConfig;
  /** The secrets it was given that hold a value: what its code was built with, and its webhooks are pointed with. */
  secrets: Readonly<Record<string, string>>;
  models: ModelEnvironment;
  /** What the agent works on, resolved for this instance. */
  content: readonly ResolvedContent[];
  /** The project directory: whose `.secrets/` the instance reads. */
  agentDir: string;
  /** The agent's working directory. */
  workdir: string;
  /** Where the instance's state is: its storage, its channels' and schedules' state, its wake-ups. */
  stateRoot: string;
  /** The definition's channels and schedules, as `serveAgent` serves them: `serveAgent(opened)`. */
  channels: BuiltDefinition["channels"];
  schedules: BuiltDefinition["schedules"];
}

/**
 * The content, once per process, before the agent opens: the locations are fixed until a restart, what is in them is
 * read per message. This process runs the agent, so a repository with no checkout here is cloned, or its clone brought
 * up to date in place where git can do so without touching the agent's work, first; then resolved again as what is now
 * on disk.
 */
async function contentForThisRun(
  dir: string,
  instance: InstanceConfigSource | undefined,
  workdir: string,
  env: NodeJS.ProcessEnv,
): Promise<ResolvedContent[]> {
  const declared = loadContent(dir, instance);
  const places = { dir, workdir };
  for (const entry of resolveContent(declared, places)) {
    if (entry.kind !== "github") continue;
    const done = await cloneContent(entry, env);
    if (done.outcome === "kept") {
      log.warn(`[fastagent] content "${entry.name}": the clone in ${entry.location} is kept as it is, ${done.reason}`);
    } else {
      const said = { cloned: "cloned", updated: "brought up to date", current: "already up to date" }[done.outcome];
      log.info(`[fastagent] github ${entry.repo}${entry.ref ? ` at ${entry.ref}` : ""}: ${said} in ${entry.location}`);
    }
  }
  return resolveContent(declared, places);
}

/** The instance's database, under its state root. */
const instanceStorageFile = (stateRoot: string) => join(stateRoot, "agent.sqlite");

/**
 * Run `work` holding the instance's storage, so no serve of the instance runs meanwhile: how a command changes the
 * instance's state outside a serve without losing a write to a serve's own.
 */
export async function holdingInstance<T>(stateRoot: string, work: () => T): Promise<T> {
  const storage = await openLockedStorage(instanceStorageFile(stateRoot), "posix", INSTANCE_HOLDERS);
  try {
    return await work();
  } finally {
    await storage.close(BACKGROUND_CONTEXT);
  }
}

function openStorage(stateRoot: string, storage: ServingStorage): Promise<Storage> | Storage {
  if (storage === "memory") return new MemoryStorage();
  if ("file" in storage) return openLockedStorage(storage.file, "posix", storage.holders);
  return openLockedStorage(instanceStorageFile(stateRoot), storage.instance, INSTANCE_HOLDERS);
}

export async function openServing(definition: AgentDefinition, options: OpenServingOptions): Promise<OpenedServing> {
  const { dir } = definition;
  const workdir = options.workdir ?? dir;
  const projectDir = options.projectDir ?? workdir;
  const config = resolveConfig(definition, options.config);
  const name = instanceName(definition.name, options.name ?? config.name);
  const text = openText(dir, options.config);
  const mcpServers = declareMcp(dir, options.config);
  // The instance's values are ONE input every reader below is given, and this process's is never written: a process
  // may run several agents, each with its own values and packages.
  const secrets = definedValues(options.secrets);
  const code = buildDefinition(definition, secrets, { ...config, dev: servedByDev(options.ownEnv) });
  // FastAgent's own work for the instance (installing packages, cloning content, finding its files) runs in this
  // process's environment and the instance's secrets. What the AGENT starts gets an environment assembled from inputs.
  const env = { ...options.ownEnv, ...secrets };
  const packages = await prepareEnvironment(dir, env, { ...env, PATH: options.env.PATH });
  const processEnv = processEnvironment(
    {
      base: options.env,
      secrets,
      declared: definition.inputs.secrets.map(({ name }) => name),
      packages,
      workdir,
    },
    dirname(workdir),
  );
  const content = await contentForThisRun(dir, options.config, workdir, env);
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
  const chosen = options.storage ?? { instance: "posix" };
  const storage = await openStorage(stateRoot, chosen);
  let mcp: McpClients | undefined;
  let agent: DurableAgent;
  try {
    const mcpEnvironment = { ...secrets, ...options.mcp?.variables };
    mcp = await openMcpClients(
      resolveMcpServers(mcpServers, mcpEnvironment, undefined, workdir, processEnv),
      options.keeps === "state"
        ? mcpAuthorizationInState(stateRoot, options.mcp)
        : mcpAuthorization(projectDir, env, stateRoot, options.mcp),
      options.mcp,
    );
    agent = await assembleAgent(definition, {
      name,
      mcpTools: mcpTools(mcp.tools),
      ownEnv: options.ownEnv,
      storage,
      code,
      config,
      text,
      content,
      workdir,
      processEnv,
      models: models.models,
      ...(models.catalogProblem === undefined ? {} : { catalogProblem: models.catalogProblem }),
      ...(typeof chosen === "object" && "instance" in chosen ? { stateRoot } : {}),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
      ...(options.unfinished === undefined ? {} : { unfinished: options.unfinished }),
      ...(options.wakeTicking === undefined ? {} : { wakeTicking: options.wakeTicking }),
    });
  } catch (error) {
    const failures: unknown[] = [error];
    if (mcp) await mcp.close().catch((cleanup: unknown) => failures.push(cleanup));
    await storage.close(BACKGROUND_CONTEXT).catch((cleanup: unknown) => failures.push(cleanup));
    throw failures.length === 1 ? error : new AggregateError(failures, "Agent open and cleanup failed");
  }
  // A storage failure or a direct harness close also ends the resources this open acquired.
  void agent.harness.closed
    .then(() => mcp.close())
    .catch((error: unknown) => {
      log.warn(`[fastagent] MCP cleanup after harness shutdown failed: ${String(error)}`);
    });
  const closeAgent = agent.close.bind(agent);
  let closing: Promise<void> | undefined;
  agent.close = () =>
    (closing ??= (async () => {
      const failures: unknown[] = [];
      await closeAgent().catch((error: unknown) => failures.push(error));
      await mcp.close().catch((error: unknown) => failures.push(error));
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
    content,
    agentDir: projectDir,
    workdir,
    stateRoot,
    channels: code.channels,
    schedules: code.schedules,
  };
}

/** An agent opened in this process (SPEC.md §8): the Agent API, and how it is served and operated. */
export interface LocalAgent extends Agent {
  /**
   * Channels, schedules and wake-ups, `/health`, and the Agent API under `/v1` when `apiKeys` holds a key: a Fetch
   * handler, or a server of its own (`listen`).
   */
  serve(options?: ServeAgentOptions): Promise<Service>;
  /** pi-durable's own API, for operating the agent. */
  readonly harness: Harness;
  /** Close what `serve` started, then release the instance's storage. */
  close(): Promise<void>;
}

export interface ServeAgentOptions {
  /** The keys a Caller of the Agent API may present (SPEC.md §9.1). */
  apiKeys?: readonly string[];
}

/** The instance root, the agent's working directory with its state in `.state/`; or the two apart (SPEC.md §8). */
export type InstanceLocation = { root: string } | { stateDir: string; workdir: string };

export type OpenAgentOptions<Settings = unknown> = InstanceLocation & {
  /** The instance configuration, over the program's defaults: an object, or the absolute path of a `fastagent.json`. */
  config?: InstanceConfig<Settings> | string;
  /** The instance's name, over `config`'s: one path segment. Default: `config`'s, else the definition's as one. */
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
  /** Per-instance MCP grants and interpolation values; no global credential discovery. */
  mcp?: McpOptions;
  /** `"provider/modelId"`, over the definition's: what a session that names none answers with. */
  model?: string;
  /** Where provider credentials are kept, instead of the state directory's `auth.json`. */
  credentials?: CredentialStore;
  /** Refresh the model lists without the network: each is the one last kept, or pi-ai's own. Default: false. */
  offline?: boolean;
};

/** The `config` input as a source: an object as it is, a path (absolute, like every path here) read. */
async function configOf(config: OpenAgentOptions["config"]): Promise<InstanceConfigSource | undefined> {
  if (config === undefined) return undefined;
  if (typeof config !== "string") return { values: config, label: "the config object" };
  if (!isAbsolute(config)) throw new Error(`config must be an absolute path, and is ${JSON.stringify(config)}`);
  return readInstanceConfigFile(config);
}

/** Where the instance is, every path absolute: a relative one would be an input the process's cwd chooses. */
function locationOf(location: InstanceLocation): { workdir: string; stateRoot: string } {
  const absolute = (path: unknown, name: string): string => {
    if (typeof path !== "string" || !isAbsolute(path)) {
      throw new Error(`${name} must be an absolute path, and is ${JSON.stringify(path)}`);
    }
    return path;
  };
  if ("root" in location && ("stateDir" in location || "workdir" in location)) {
    throw new Error("give the instance a root, or a stateDir and a workdir, not both");
  }
  if ("root" in location) {
    const root = absolute(location.root, "root");
    return { workdir: root, stateRoot: join(root, STATE_DIRNAME) };
  }
  return { workdir: absolute(location.workdir, "workdir"), stateRoot: absolute(location.stateDir, "stateDir") };
}

/**
 * Open one instance of `definition`, the default export of an agent's package, the way `dev` and `start` do before they
 * serve: its code built with the secrets it declares, its environment, its content and the instance's storage, which
 * one process holds at a time. Nothing reaches the agent until `serve`.
 */
export async function openAgent<Settings = unknown>(
  definition: AgentDefinition<Settings>,
  options: OpenAgentOptions<Settings>,
): Promise<LocalAgent> {
  const { workdir, stateRoot } = locationOf(options);
  const config = await configOf(options.config);
  // An app may never serve the agent, and then no clock fires a wake-up: `wake` is refused until it does.
  let ticking = false;
  const opened = await openServing(assertDefinition(definition), {
    workdir,
    stateRoot,
    secrets: options.secrets ?? {},
    env: options.env ?? {},
    ownEnv: options.env ?? {},
    offline: options.offline === true,
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(config === undefined ? {} : { config }),
    wakeTicking: () => ticking,
    keeps: "state",
    ...(options.mcp === undefined ? {} : { mcp: options.mcp }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.credentials === undefined ? {} : { credentialStore: piCredentials(options.credentials) }),
  });
  const { agent } = opened;
  let served: Promise<Service> | undefined;
  let closing: Promise<void> | undefined;
  return {
    info: agent.info,
    usage: agent.usage,
    sessions: agent.sessions,
    messages: agent.messages,
    harness: agent.harness,
    serve(serveOptions = {}) {
      // Its storage is let go, or about to be: a service now would run channels and schedules nobody closes.
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
