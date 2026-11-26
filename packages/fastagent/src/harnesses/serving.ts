/**
 * Unified serving orchestrator for FastAgent: prepares the agent's definition, secrets, process environment,
 * model environment, MCP clients, and remote auth manager once, then delegates runtime construction to the
 * selected harness (`pi-durable` or `dsh`).
 */
import { dirname, isAbsolute, join } from "node:path";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import type { Agent, InvokeApi } from "@fastagent-sh/client/agent-api";
import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import { type WorkTracker, createWorkTracker } from "../busy.ts";
import { processEnvironment } from "../child-env.ts";
import { createCloseSignal } from "../close-signal.ts";
import {
  createInvoker,
  memoryConversationStore,
  postgresConversationStore,
  sqliteConversationStore,
} from "../conversations.ts";
import {
  type RedactedSecrets,
  type SecretInput,
  type SecretValuesInput,
  redactValues,
  revealValues,
} from "../declared-secrets.ts";
import { instanceName, INSTANCE_NAME_ENV } from "../instance-name.ts";
import { type McpClients, openMcpClients } from "../mcp/client.ts";
import { declareMcp, resolveMcpServers } from "../mcp/config.ts";
import { DATABASE_URL_ENV, STATE_DIRNAME, resolveStateRoot } from "../paths.ts";
import { PromiseFailure, fromPromise, originalError } from "../promise-bridge.ts";
import { type Service, serveAgent } from "../service.ts";
import { NOT_HOSTED, type RunsAs } from "../serving-command.ts";
import { fastagentVersion } from "../version.ts";
import { type BuiltDefinition, type Unfinished, buildDefinition } from "./assembly.ts";
import { type HarnessSelection, resolveHarnessSelection } from "./config.ts";
import type { AgentConfig, HarnessName, SandboxMode } from "./define.ts";
import { loadDshModule, openDshRuntime } from "./dsh/runtime.ts";
import { overlayCredentialStore } from "./models/credentials.ts";
import {
  type ManagedDurableCredentialStore,
  postgresDurableCredentialStore,
  sqliteDurableCredentialStore,
} from "./models/durable-credentials.ts";
import { type ModelEnvironment, modelEnvironment } from "./models/environment.ts";
import { type AuthManager, createAuthManager } from "./models/remote-auth.ts";
import { openPiDurableRuntime } from "./pi-durable/runtime.ts";
import { type AgentDefinition, assertDefinition } from "../definition/definition.ts";
import {
  type PostgresDatabase,
  type SharedPostgresDatabase,
  describeDatabase,
  isSharedPostgresDatabase,
  messageBytesFor,
  openPostgresDatabase,
} from "../postgres.ts";
import { otlpTraces } from "./telemetry/otlp.ts";
import { log } from "../log.ts";

export interface OpenServingOptions {
  /**
   * Where the instance keeps its fallback file credentials when no durable store owns the provider:
   * - `"secrets"` (default): `<projectDir>/.secrets/auth.json` layered over global credentials (the CLI's).
   * - `"state"`: `<stateRoot>/auth.json` only (an embedded app's).
   * - `"none"`: no credentials file at all (environment variables only).
   * - `{ file }`: an explicit credentials file path.
   */
  auth?: "secrets" | "state" | "none" | { readonly file: string };
  /** The instance's name. Default: the definition's, as one segment. */
  name?: string;
  /**
   * The values the instance's code, its MCP servers and its model's authentication read by name (`needs`, `${VAR}`,
   * a provider's variable): the one source of them, never this process's environment. A caller that wants its own
   * passes it (`process.env`).
   */
  secrets: SecretValuesInput;
  /**
   * The base environment of the processes the agent starts (`baseEnv(process.env)` is the CLI's), plus the declared
   * secrets. Nothing else of this process's reaches them.
   */
  env: Readonly<Record<string, string>>;
  /**
   * The environment FastAgent's own work for the instance runs in (such as instance root, harness/sandbox overrides,
   * and OTLP variables). The CLI gives this process's; an app, its `env`. The instance's secrets are added to it.
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
  /** The PostgreSQL database the instance's storage is in, over the one `FASTAGENT_DATABASE_URL` names. */
  database?: PostgresDatabase;
}

export type ServingStorage = "instance" | { file: string; holders?: string } | "memory";

/** An opened agent from any harness: the Agent API plus runtime lifecycle signals. */
export interface ServingAgent extends Agent {
  /** Resolves once the runtime has stopped (explicit close or single-writer lease loss). */
  readonly closed?: Promise<void>;
  /** Synchronously reports whether the runtime has not started closing. */
  ready?(): boolean;
  /** Subscribe to shutdown start (synchronously, before async cleanup settles). */
  subscribeClose?(listener: () => void): () => void;
  busy?(): boolean;
  close(): Promise<void>;
}

export interface OpenedServing {
  agent: ServingAgent;
  /** Single-call invoker backed by this instance's conversation store. */
  invoker: InvokeApi;
  /** Whether this instance has any unsettled turn or active remote auth flow. */
  busy(): boolean;
  /** The active runtime harness (`"pi-durable"` or `"dsh"`). */
  harness: HarnessName;
  /** The active OS sandbox mode when `harness === "dsh"`. */
  sandbox?: SandboxMode;
  /** The instance's remote authentication manager, backed by durable storage. */
  auth?: AuthManager;
  definition: AgentDefinition;
  /** The instance's name: what `info().name` reports. */
  name: string;
  code: BuiltDefinition;
  /** The definition's configuration (`fastagent.config.ts`). */
  config: AgentConfig;
  /** The secrets it was given that hold a value, kept redacted in runtime state. */
  secrets: RedactedSecrets;
  models: ModelEnvironment;
  /** The project directory: whose `.secrets/` the instance reads. */
  agentDir: string;
  /** The agent's working directory. */
  workdir: string;
  /** Where the instance's state is stored. */
  stateRoot: string;
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
  readonly database: SharedPostgresDatabase | undefined;
  readonly maxMessageBytes: number | undefined;
  readonly storageDescription: string;
  readonly secrets: RedactedSecrets;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly processEnv: Readonly<Record<string, string>>;
  readonly code: BuiltDefinition;
  readonly models: ModelEnvironment;
  readonly telemetry: TelemetryContext | undefined;
  readonly work: WorkTracker;
  openMcp(): Promise<McpClients>;
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

async function runServingPromise<A>(effect: Effect.Effect<A, PromiseFailure>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw originalError(exit.cause);
}

const openServingEffect = Effect.fn("serving.openServing")(function* (
  definition: AgentDefinition,
  options: OpenServingOptions,
) {
  const { dir, config } = definition;
  const workdir = options.workdir ?? dir;
  const projectDir = options.projectDir ?? workdir;
  const selection = yield* Effect.try({
    try: () =>
      resolveHarnessSelection(
        config,
        {
          ...(options.harness === undefined ? {} : { harness: options.harness }),
          ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
        },
        options.ownEnv,
      ),
    catch: (cause) => new PromiseFailure(cause),
  });
  const dshModule = selection.harness === "dsh" ? yield* fromPromise(() => loadDshModule()) : undefined;
  const name = yield* Effect.try({
    try: () => instanceName(definition.name, options.name),
    catch: (cause) => new PromiseFailure(cause),
  });
  const mcpServers = yield* Effect.try({
    try: () => declareMcp(config.mcpServers, dir),
    catch: (cause) => new PromiseFailure(cause),
  });
  const redactedSecrets = redactValues(options.secrets);
  const secrets = revealValues(redactedSecrets);
  const code = yield* Effect.try({
    try: () => buildDefinition(definition, secrets),
    catch: (cause) => new PromiseFailure(cause),
  });
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
  const authPath: string | null | undefined =
    options.auth === undefined || options.auth === "secrets"
      ? undefined
      : options.auth === "state"
        ? join(stateRoot, "auth.json")
        : options.auth === "none"
          ? null
          : options.auth.file;
  const chosen = options.storage ?? "instance";
  const place: InstancePlace = {
    stateRoot,
    env,
    agent: definition.name,
    ...(options.name === undefined ? {} : { name }),
    ...(options.database === undefined ? {} : { database: options.database }),
  };
  const rawDatabase = chosen === "instance" ? databaseOf(place) : undefined;
  const storageDescription = describeInstanceStorage(place);
  const serviceVersion = yield* fromPromise(() => fastagentVersion());

  const lifetime = yield* Scope.make();
  const recordFailures = yield* Ref.make(false);
  const cleanupFailures = yield* Ref.make<unknown[]>([]);
  // Finalizers never fail (Effect 4 turns finalizer defects into masked body errors): during normal close they
  // record failures into `cleanupFailures` so every step still runs and all failures surface together.
  const release = (step: () => void | Promise<void>): Effect.Effect<void> =>
    fromPromise(async () => step()).pipe(
      Effect.catchCause((cause) =>
        Ref.get(recordFailures).pipe(
          Effect.flatMap((recording) =>
            recording ? Ref.update(cleanupFailures, (list) => [...list, originalError(cause)]) : Effect.void,
          ),
        ),
      ),
    );

  return yield* Effect.gen(function* () {
    const sharedDatabase: SharedPostgresDatabase | undefined =
      rawDatabase === undefined
        ? undefined
        : isSharedPostgresDatabase(rawDatabase)
          ? rawDatabase
          : yield* Effect.acquireRelease(
              Effect.try({
                try: () => openPostgresDatabase(rawDatabase),
                catch: (cause) => new PromiseFailure(cause),
              }),
              (pg) => release(() => pg.close()),
            );
    const database = sharedDatabase;
    // Fail fast on invalid OTLP settings before opening credentials or harness storage.
    const traces = yield* Effect.acquireRelease(
      Effect.try({
        try: () => otlpTraces(env, { serviceName: name, serviceVersion }),
        catch: (cause) => new PromiseFailure(cause),
      }),
      (created) => (created === undefined ? Effect.void : release(() => created.close())),
    );
    if (chosen === "instance" && database !== undefined && place.name === undefined) {
      return yield* Effect.fail(
        new PromiseFailure(
          new Error(
            "an instance in a database is opened by its name, and none was given: " +
              `set ${INSTANCE_NAME_ENV} (an app: openAgent's name)`,
          ),
        ),
      );
    }
    // Register conversations cleanup before durableCreds/runtimeAgent while opening it only after runtimeAgent
    // succeeds (so a locked/failing instance never creates or touches `conversations.sqlite`), preserving LIFO order:
    // auth -> runtimeAgent -> durableCreds -> conversations -> traces -> ownedSharedPg.
    const conversationsRef = yield* Ref.make<ReturnType<typeof memoryConversationStore> | undefined>(undefined);
    yield* Effect.addFinalizer(() =>
      Ref.get(conversationsRef).pipe(
        Effect.flatMap((store) => (store === undefined ? Effect.void : release(() => store.close()))),
      ),
    );
    const durableCreds: ManagedDurableCredentialStore | undefined =
      chosen === "instance"
        ? yield* Effect.acquireRelease(
            Effect.try({
              try: () =>
                database !== undefined
                  ? postgresDurableCredentialStore(database, place.name as string)
                  : sqliteDurableCredentialStore(join(stateRoot, "credentials.sqlite")),
              catch: (cause) => new PromiseFailure(cause),
            }),
            (store) => release(() => store.close()),
          )
        : undefined;
    const models = yield* fromPromise(() =>
      modelEnvironment(projectDir, authPath === undefined ? {} : { authPath }, code.providers, {
        environment: secrets,
        ...(durableCreds !== undefined
          ? { credentialStore: (fallback) => overlayCredentialStore(() => durableCreds, fallback) }
          : {}),
      }),
    );
    const work = createWorkTracker();
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
      maxMessageBytes: messageBytesFor(database?.limits),
      storageDescription,
      secrets: redactedSecrets,
      env,
      processEnv,
      code,
      models,
      telemetry: traces?.context,
      work,
      openMcp: () => openMcpClients(resolveMcpServers(mcpServers, secrets, undefined, workdir, processEnv)),
    };
    const runtimeAgent = yield* Effect.acquireRelease(
      fromPromise(() => (dshModule !== undefined ? openDshRuntime(ctx, dshModule) : openPiDurableRuntime(ctx))),
      (agent) => release(() => agent.close()),
    );
    const conversations = yield* Effect.try({
      try: () =>
        chosen === "memory"
          ? memoryConversationStore()
          : chosen !== "instance"
            ? sqliteConversationStore(`${chosen.file}.conversations.sqlite`)
            : database !== undefined
              ? postgresConversationStore(database, place.name as string)
              : sqliteConversationStore(join(stateRoot, "conversations.sqlite")),
      catch: (cause) => new PromiseFailure(cause),
    });
    yield* Ref.set(conversationsRef, conversations);
    const auth: AuthManager | undefined =
      durableCreds !== undefined
        ? yield* Effect.acquireRelease(
            Effect.try({
              try: () =>
                createAuthManager({
                  models,
                  durableStore: durableCreds,
                  providers: code.providers,
                  environment: secrets,
                  work,
                }),
              catch: (cause) => new PromiseFailure(cause),
            }),
            (manager) => release(() => manager.close()),
          )
        : undefined;

    const closeSignal = createCloseSignal();
    runtimeAgent.subscribeClose?.(closeSignal.mark);
    if (auth !== undefined) {
      closeSignal.subscribe(() => auth.close());
    }
    const closedGate = Promise.withResolvers<void>();
    const closeOutcome = Ref.makeUnsafe<Deferred.Deferred<void, PromiseFailure> | undefined>(undefined);
    const closeAgentEffect = Effect.fn("serving.closeAgent")(function* () {
      const decision = yield* Ref.modify(
        closeOutcome,
        (
          current,
        ): readonly [
          {
            readonly isLeader: boolean;
            readonly deferred: Deferred.Deferred<void, PromiseFailure>;
          },
          Deferred.Deferred<void, PromiseFailure>,
        ] => {
          if (current !== undefined) return [{ isLeader: false, deferred: current }, current];
          const next = Deferred.makeUnsafe<void, PromiseFailure>();
          return [{ isLeader: true, deferred: next }, next];
        },
      );
      if (!decision.isLeader) return yield* Deferred.await(decision.deferred);
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          yield* Ref.set(recordFailures, true);
          yield* Scope.close(lifetime, Exit.void).pipe(Effect.ensuring(Effect.sync(() => closedGate.resolve())));
          const failures = yield* Ref.get(cleanupFailures);
          const finalExit =
            failures.length === 0
              ? Exit.void
              : Exit.fail(
                  new PromiseFailure(
                    failures.length === 1 ? failures[0] : new AggregateError(failures, "Agent close failed"),
                  ),
                );
          yield* Deferred.done(decision.deferred, finalExit);
        }),
      );
      return yield* Deferred.await(decision.deferred);
    });

    const wrappedAgent: ServingAgent = {
      ...runtimeAgent,
      closed: closedGate.promise,
      ready: () => !closeSignal.isClosing(),
      subscribeClose: closeSignal.subscribe,
      close: () => {
        closeSignal.mark();
        return runServingPromise(closeAgentEffect());
      },
    };
    void runtimeAgent.closed?.then(
      () =>
        wrappedAgent.close().catch((error: unknown) => {
          log.warn(`[fastagent] closing after runtime shutdown failed: ${String(error)}`);
        }),
      () =>
        wrappedAgent.close().catch((error: unknown) => {
          log.warn(`[fastagent] closing after runtime shutdown failed: ${String(error)}`);
        }),
    );
    const invoker = createInvoker(wrappedAgent, conversations, { keyPrefix: `${selection.harness}:` });

    return {
      agent: wrappedAgent,
      invoker,
      busy: () => work.active() > 0 || (runtimeAgent.busy?.() ?? false),
      harness: selection.harness,
      ...(selection.sandbox === undefined ? {} : { sandbox: selection.sandbox }),
      ...(auth === undefined ? {} : { auth }),
      definition,
      name,
      code,
      config,
      secrets: redactedSecrets,
      models,
      agentDir: projectDir,
      workdir,
      stateRoot,
    } satisfies OpenedServing;
  }).pipe(
    Scope.provide(lifetime),
    Effect.onError(() => Scope.close(lifetime, Exit.void)),
  );
});

export function openServing(definition: AgentDefinition, options: OpenServingOptions): Promise<OpenedServing> {
  return runServingPromise(openServingEffect(definition, options));
}

/** An agent opened in this process: the Agent API, and how it is served and operated. */
export interface LocalAgent extends Agent, InvokeApi {
  /**
   * `/health` and the Agent API under `/v1` when `apiKeys` holds a key: a Fetch
   * handler, or a server of its own (`listen`).
   */
  serve(options?: ServeAgentOptions): Promise<Service>;
  /** Resolves once the instance stops serving (explicit `close()` or single-writer lease loss). */
  readonly closed?: Promise<void>;
  /** Whether the runtime is ready to accept work (false as soon as shutdown starts, before cleanup settles). */
  ready(): boolean;
  /**
   * Whether the process has work in flight (a message not yet ended or an active login flow).
   * For a platform that reclaims an idle machine (AgentCore's `HealthyBusy`).
   */
  busy(): boolean;
  /** Close what `serve` started, then release the instance's storage. */
  close(): Promise<void>;
}

export interface ServeAgentOptions {
  /** The keys a Caller of the Agent API may present. */
  apiKeys?: readonly SecretInput[];
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
  secrets?: SecretValuesInput;
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
   * The PostgreSQL database the instance's sessions are in, instead of `<root>/.state/agent.sqlite`: its URL,
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
    auth: "state",
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.harness === undefined ? {} : { harness: options.harness }),
    ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
    ...(options.database === undefined ? {} : { database: options.database }),
  });
  const { agent, invoker } = opened;
  type LocalAgentState =
    | { readonly _tag: "idle" }
    | { readonly _tag: "serving"; readonly ready: Deferred.Deferred<Service, PromiseFailure> }
    | { readonly _tag: "served"; readonly service: Service }
    | { readonly _tag: "closed"; readonly done: Deferred.Deferred<void, PromiseFailure> };
  const state = Ref.makeUnsafe<LocalAgentState>({ _tag: "idle" });

  const serveEffect = Effect.fn("serving.localAgent.serve")(function* (serveOptions: ServeAgentOptions = {}) {
    const decision = yield* Ref.modify(
      state,
      (
        current,
      ): readonly [
        (
          | { readonly _tag: "lead"; readonly ready: Deferred.Deferred<Service, PromiseFailure> }
          | { readonly _tag: "refused"; readonly reason: string }
        ),
        LocalAgentState,
      ] => {
        if (current._tag === "closed") return [{ _tag: "refused", reason: "this agent is closed" }, current];
        if (current._tag !== "idle") return [{ _tag: "refused", reason: "this agent is already served" }, current];
        const ready = Deferred.makeUnsafe<Service, PromiseFailure>();
        return [
          { _tag: "lead", ready },
          { _tag: "serving", ready },
        ];
      },
    );
    if (decision._tag === "refused") {
      return yield* Effect.fail(new PromiseFailure(new Error(decision.reason)));
    }
    const outcome = yield* Effect.uninterruptible(
      fromPromise(() => serveAgent(opened, serveOptions)).pipe(
        Effect.exit,
        Effect.tap((exit) =>
          Ref.update(state, (current): LocalAgentState => {
            if (current._tag !== "serving" || current.ready !== decision.ready) return current;
            return Exit.isSuccess(exit) ? { _tag: "served", service: exit.value } : { _tag: "idle" };
          }),
        ),
        Effect.tap((exit) => Deferred.done(decision.ready, exit)),
      ),
    );
    return yield* outcome;
  });

  const closeEffect = Effect.fn("serving.localAgent.close")(function* () {
    const decision = yield* Ref.modify(
      state,
      (
        current,
      ): readonly [
        (
          | { readonly _tag: "join"; readonly done: Deferred.Deferred<void, PromiseFailure> }
          | {
              readonly _tag: "lead";
              readonly done: Deferred.Deferred<void, PromiseFailure>;
              readonly previous: LocalAgentState;
            }
        ),
        LocalAgentState,
      ] => {
        if (current._tag === "closed") return [{ _tag: "join", done: current.done }, current];
        const done = Deferred.makeUnsafe<void, PromiseFailure>();
        return [
          { _tag: "lead", done, previous: current },
          { _tag: "closed", done },
        ];
      },
    );
    if (decision._tag === "join") return yield* Deferred.await(decision.done);
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        let service: Service | undefined;
        if (decision.previous._tag === "served") {
          service = decision.previous.service;
        } else if (decision.previous._tag === "serving") {
          const servedExit = yield* Effect.exit(Deferred.await(decision.previous.ready));
          if (Exit.isSuccess(servedExit)) service = servedExit.value;
        }
        const failures: unknown[] = [];
        if (service !== undefined) {
          const serviceClose = service.close;
          const exit = yield* Effect.exit(fromPromise(() => serviceClose()));
          if (Exit.isFailure(exit)) failures.push(originalError(exit.cause));
        }
        const agentExit = yield* Effect.exit(fromPromise(() => agent.close()));
        if (Exit.isFailure(agentExit)) failures.push(originalError(agentExit.cause));
        const finalExit =
          failures.length === 0
            ? Exit.void
            : Exit.fail(
                new PromiseFailure(
                  failures.length === 1 ? failures[0] : new AggregateError(failures, "the agent did not close cleanly"),
                ),
              );
        yield* Deferred.done(decision.done, finalExit);
      }),
    );
    return yield* Deferred.await(decision.done);
  });

  return {
    info: agent.info,
    usage: agent.usage,
    sessions: agent.sessions,
    messages: agent.messages,
    invoke: invoker.invoke,
    invokeStream: invoker.invokeStream,
    ...(agent.closed === undefined ? {} : { closed: agent.closed }),
    ready: () => Ref.getUnsafe(state)._tag !== "closed" && (agent.ready?.() ?? true),
    busy: () => opened.busy(),
    serve: (serveOptions = {}) => runServingPromise(serveEffect(serveOptions)),
    close: () => runServingPromise(closeEffect()),
  };
}
