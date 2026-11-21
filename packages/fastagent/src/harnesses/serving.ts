/**
 * Unified serving orchestrator for FastAgent: prepares the agent's definition, secrets, process environment,
 * model environment, MCP clients, remote auth manager, and external clock runner once, then delegates runtime
 * construction to the selected harness (`pi-durable` or `dsh`).
 */
import { dirname, isAbsolute, join } from "node:path";
import type { Agent } from "@fastagent-sh/client/agent-api";
import type { Harness } from "@earendil-works/pi-durable";
import { activeWork } from "../busy.ts";
import { processEnvironment } from "../child-env.ts";
import { definedValues } from "../declared-secrets.ts";
import { instanceName, INSTANCE_NAME_ENV } from "../instance-name.ts";
import { type McpClients, openMcpClients } from "../mcp/client.ts";
import { declareMcp, resolveMcpServers } from "../mcp/config.ts";
import { DATABASE_URL_ENV, STATE_DIRNAME, resolveStateRoot } from "../paths.ts";
import type { ClockStore } from "../schedule/clock.ts";
import { type ClockRunner, createClockRunner } from "../schedule/runner.ts";
import { type Service, serveAgent } from "../service.ts";
import { NOT_HOSTED, type RunsAs } from "../serving-command.ts";
import { loadDshModule, openDshRuntime, withDshInstanceClock } from "./dsh/runtime.ts";
import { type ModelEnvironment, modelEnvironment } from "./models/environment.ts";
import { type AuthManager, createAuthManager } from "./models/remote-auth.ts";
import { watchInstanceAlarm } from "./pi-durable/alarm.ts";
import type { Unfinished } from "./pi-durable/agent.ts";
import { type HarnessSelection, resolveHarnessSelection } from "./pi-durable/config.ts";
import { type DurableCredentialStore, overlayCredentialStore } from "./pi-durable/credentials.ts";
import type { AgentConfig, HarnessName, SandboxMode } from "./pi-durable/define.ts";
import { type AgentDefinition, assertDefinition } from "./pi-durable/definition.ts";
import { type BuiltDefinition, buildDefinition } from "./pi-durable/open.ts";
import { describeDatabase } from "./pi-durable/postgres/database.ts";
import type { PostgresDatabase } from "./pi-durable/postgres/storage.ts";
import { openPiDurableRuntime, withPiDurableInstanceClock } from "./pi-durable/runtime.ts";

export interface OpenServingOptions {
  /** Override the credentials file, or `null` to read no credentials file at all. */
  authPath?: string | null;
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
  /** What a deployment sets over the definition's model (a flag, `FASTAGENT_MODEL`). */
  model?: string;
  /** Runtime harness override (`--harness` / `FASTAGENT_HARNESS` / `fastagent.config.ts`). */
  harness?: HarnessName;
  /** OS sandbox mode override for `harness: "dsh"` (`--sandbox` / `FASTAGENT_SANDBOX` / `fastagent.config.ts`). */
  sandbox?: SandboxMode;
  /**
   * Where the Agent keeps its sessions. Default `"instance"`: the instance's `agent.sqlite`, or the PostgreSQL database
   * `FASTAGENT_DATABASE_URL` names, which one process holds at a time. `{ file }` opens a caller-owned SQLite file;
   * `"memory"` keeps nothing on disk.
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
   * app's). Default `"secrets"`.
   */
  keeps?: "secrets" | "state";
  /** The PostgreSQL database the instance's storage is in, over the one `FASTAGENT_DATABASE_URL` names. */
  database?: PostgresDatabase;
}

export type ServingStorage = "instance" | { file: string; holders?: string } | "memory";

/** An opened agent from either harness: the Agent API plus lifecycle and optional `pi-durable` harness handle. */
export interface ServingAgent extends Agent {
  readonly harness?: Harness;
  busy?(): boolean;
  close(): Promise<void>;
}

export interface OpenedServing {
  agent: ServingAgent;
  /** The active runtime harness (`"pi-durable"` or `"dsh"`). */
  harness: HarnessName;
  /** The active OS sandbox mode when `harness === "dsh"`. */
  sandbox?: SandboxMode;
  /** The instance's external clock runner, when opened on durable instance storage. */
  clock?: ClockRunner;
  /** The instance's remote authentication manager, backed by durable storage. */
  auth?: AuthManager;
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
  /** Its database, given: over the one `FASTAGENT_DATABASE_URL` names. */
  database?: PostgresDatabase;
}

/** Shared context prepared once by `openServing()` and handed to the selected harness runtime adapter. */
export interface HarnessOpenContext {
  readonly definition: AgentDefinition;
  readonly options: OpenServingOptions;
  readonly selection: HarnessSelection;
  readonly name: string;
  readonly workdir: string;
  readonly projectDir: string;
  readonly stateRoot: string;
  readonly chosen: ServingStorage;
  readonly place: InstancePlace;
  readonly database: PostgresDatabase | undefined;
  readonly storageDescription: string;
  readonly secrets: Readonly<Record<string, string>>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly processEnv: Readonly<Record<string, string>>;
  readonly code: BuiltDefinition;
  readonly models: ModelEnvironment;
  openMcp(): Promise<McpClients>;
  setDurableCreds(creds: DurableCredentialStore): void;
  closeAuth(): void;
}

/** Engine-specific handles returned by a harness runtime adapter to `openServing()`. */
export interface OpenedHarnessRuntime {
  readonly agent: ServingAgent;
  readonly durableCreds?: DurableCredentialStore;
  readonly clockStore?: ClockStore;
}

/** The database the instance's storage is in: the one given, or the one `FASTAGENT_DATABASE_URL` names, or none. */
function databaseOf(place: InstancePlace): PostgresDatabase | undefined {
  if (place.database !== undefined) return place.database;
  const url = place.env[DATABASE_URL_ENV];
  return url ? { url } : undefined;
}

/** Where the instance's storage is, as a person reads it: the database (without credentials), or the file. */
export function describeInstanceStorage(place: InstancePlace): string {
  const url = databaseOf(place)?.url;
  if (!url) return join(place.stateRoot, "agent.sqlite");
  const instance = place.name === undefined ? `no instance: set ${INSTANCE_NAME_ENV}` : `instance "${place.name}"`;
  return `PostgreSQL ${describeDatabase(url)}, ${instance}`;
}

/**
 * Run `work` over the clock of an instance no process serves, holding its storage meanwhile, so no serve of it starts
 * until it is done: how a command reads or changes the clock without one.
 */
export async function withInstanceClock<T>(
  place: InstancePlace & { readonly harness?: HarnessName },
  work: (clock: ClockStore) => Promise<T>,
): Promise<T> {
  const database = databaseOf(place);
  if (place.harness === "dsh") {
    return withDshInstanceClock(place, database, work);
  }
  return withPiDurableInstanceClock(place, database, work);
}

export async function openServing(definition: AgentDefinition, options: OpenServingOptions): Promise<OpenedServing> {
  const { dir, config } = definition;
  const workdir = options.workdir ?? dir;
  const projectDir = options.projectDir ?? workdir;
  const selection = resolveHarnessSelection(
    config,
    {
      ...(options.harness === undefined ? {} : { harness: options.harness }),
      ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
    },
    options.ownEnv,
  );
  const dshModule = selection.harness === "dsh" ? await loadDshModule() : undefined;
  const name = instanceName(definition.name, options.name);
  const mcpServers = declareMcp(config.mcpServers, dir);
  const secrets = definedValues(options.secrets);
  const code = buildDefinition(definition, secrets);
  const env = { ...options.ownEnv, ...secrets };
  const processEnv = processEnvironment(
    {
      base: options.env,
      secrets,
      declared: definition.inputs.secrets.map(({ name: secretName }) => secretName),
      workdir,
    },
    dirname(workdir),
  );
  const stateRoot = options.stateRoot ?? resolveStateRoot(projectDir, env);
  const authPath =
    options.authPath !== undefined
      ? options.authPath
      : options.keeps === "state"
        ? join(stateRoot, "auth.json")
        : undefined;
  const chosen = options.storage ?? "instance";
  let durableCreds: DurableCredentialStore | undefined;
  const models = await modelEnvironment(projectDir, authPath === undefined ? {} : { authPath }, code.providers, {
    stateRoot,
    environment: secrets,
    env,
    ...(chosen === "instance"
      ? { credentialStore: (fallback) => overlayCredentialStore(() => durableCreds, fallback) }
      : {}),
  });
  const place: InstancePlace = {
    stateRoot,
    env,
    agent: definition.name,
    ...(options.name === undefined ? {} : { name }),
    ...(options.database === undefined ? {} : { database: options.database }),
  };

  const database = chosen === "instance" ? databaseOf(place) : undefined;
  const storageDescription = describeInstanceStorage(place);
  let clock: ClockRunner | undefined;
  let auth: AuthManager | undefined;
  const ctx: HarnessOpenContext = {
    definition,
    options,
    selection,
    name,
    workdir,
    projectDir,
    stateRoot,
    chosen,
    place,
    database,
    storageDescription,
    secrets,
    env,
    processEnv,
    code,
    models,
    openMcp: () => openMcpClients(resolveMcpServers(mcpServers, secrets, undefined, workdir, processEnv)),
    setDurableCreds: (creds) => {
      durableCreds = creds;
    },
    closeAuth: () => auth?.close(),
  };

  const openedRuntime =
    dshModule !== undefined ? await openDshRuntime(ctx, dshModule) : await openPiDurableRuntime(ctx);
  if (openedRuntime.durableCreds !== undefined) {
    durableCreds = openedRuntime.durableCreds;
  }
  if (chosen === "instance") {
    if (durableCreds !== undefined) {
      auth = createAuthManager({
        models,
        durableStore: durableCreds,
        providers: code.providers,
        environment: secrets,
      });
    }
    if (openedRuntime.clockStore !== undefined) {
      clock = createClockRunner({
        agent: openedRuntime.agent,
        store: openedRuntime.clockStore,
        schedules: code.schedules,
      });
    }
  }

  return {
    agent: openedRuntime.agent,
    harness: selection.harness,
    ...(selection.sandbox === undefined ? {} : { sandbox: selection.sandbox }),
    ...(clock === undefined ? {} : { clock }),
    ...(auth === undefined ? {} : { auth }),
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
  /** pi-durable's own API when running on `harness: "pi-durable"`; absent on `harness: "dsh"`. */
  readonly harness?: Harness;
  /**
   * Whether the process has work in flight: a message not yet ended, or a schedule's fire before its message is taken.
   * For a platform that reclaims an idle machine (AgentCore's `HealthyBusy`).
   */
  busy(): boolean;
  /** Close what `serve` started, then release the instance's storage. */
  close(): Promise<void>;
}

export interface ServeAgentOptions {
  /** The keys a Caller of the Agent API may present. */
  apiKeys?: readonly string[];
  /**
   * Keep an external alarm armed for when this instance next needs a running process (`at`), or disarmed (`undefined`)
   * when nothing is scheduled: how a platform that stops an idle machine wakes it again.
   */
  alarm?: (at: Date | undefined) => void | Promise<void>;
  /** Stamps schedules seen for the first time, when a cold open was woken by an external alarm. */
  since?: Date;
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
  /** Runtime harness override (`"pi-durable"` or `"dsh"`). */
  harness?: HarnessName;
  /** OS sandbox mode override for `harness: "dsh"` (`"workspace"`, `"read-only"`, or `"off"`). */
  sandbox?: SandboxMode;
  /**
   * The PostgreSQL database the instance's sessions and clock are in, instead of `<root>/.state/agent.sqlite`: its URL,
   * and for a platform's own database how a connection signs in and what a transaction may hold. Over
   * `secrets.FASTAGENT_DATABASE_URL`. An instance in a database is opened by its `name`, which is then required.
   */
  database?: PostgresDatabase;
}

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
  const opened = await openServing(assertDefinition(definition), {
    workdir,
    stateRoot,
    secrets: options.secrets ?? {},
    env: options.env ?? {},
    ownEnv: options.env ?? {},
    runsAs: NOT_HOSTED,
    ...(options.name === undefined ? {} : { name: options.name }),
    keeps: "state",
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.harness === undefined ? {} : { harness: options.harness }),
    ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
    ...(options.database === undefined ? {} : { database: options.database }),
  });
  const { agent } = opened;
  const piHarness = agent.harness;
  let served: Promise<Service> | undefined;
  let closing: Promise<void> | undefined;
  return {
    info: agent.info,
    usage: agent.usage,
    sessions: agent.sessions,
    messages: agent.messages,
    ...(piHarness === undefined ? {} : { harness: piHarness }),
    busy: () => activeWork() > 0 || (agent.busy?.() ?? piHarness?.wake().active ?? false),
    serve(serveOptions = {}) {
      if (closing !== undefined) return Promise.reject(new Error("this agent is closed"));
      if (served !== undefined) return Promise.reject(new Error("this agent is already served"));
      const { alarm, ...rest } = serveOptions;
      const serving: Promise<Service> = serveAgent(opened, {
        ...rest,
        ...(alarm !== undefined && piHarness !== undefined
          ? {
              watchAlarm: (nextClockDue) => watchInstanceAlarm({ harness: piHarness, nextClockDue, setAlarm: alarm }),
            }
          : {}),
        ...(piHarness !== undefined ? { beforeTick: () => piHarness.resume() } : {}),
      });
      served = serving;
      serving.catch(() => {
        if (served === serving) served = undefined;
      });
      return serving;
    },
    close() {
      closing ??= (async () => {
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
