/**
 * Scoped runtime instance lifecycle for FastAgent: resolves secrets, process environment, storage target,
 * harness-neutral conversation & credential stores, MCP clients, remote auth manager, and single-writer
 * close-to-reopen serialization across all harnesses (`pi-durable` and `dsh`).
 */
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import type { Agent, InvokeApi } from "@fastagent-sh/client/agent-api";
import { createWorkTracker } from "../busy.ts";
import { processEnvironment } from "../child-env.ts";
import { createCloseSignal } from "../close-signal.ts";
import {
  createInvoker,
  memoryConversationStore,
  postgresConversationStore,
  sqliteConversationStore,
} from "../conversations.ts";
import { type RedactedSecrets, type SecretValuesInput, redactValues, revealValues } from "../declared-secrets.ts";
import type { AgentDefinition } from "../definition/definition.ts";
import type {
  HarnessProvider,
  HarnessRuntimeAgent,
  HarnessStorageHandle,
  HarnessTelemetryContext,
} from "../harness.ts";
import { INSTANCE_NAME_ENV, instanceName } from "../instance-name.ts";
import { log } from "../log.ts";
import { openMcpClients } from "../mcp/client.ts";
import { declareMcp, resolveMcpServers } from "../mcp/config.ts";
import { DATABASE_URL_ENV, resolveStateRoot } from "../paths.ts";
import {
  type PostgresDatabase,
  type SharedPostgresDatabase,
  describeDatabase,
  isSharedPostgresDatabase,
  openPostgresDatabase,
} from "../postgres.ts";
import { PromiseFailure, fromPromise, originalError } from "../promise-bridge.ts";
import type { RunsAs } from "../serving-command.ts";
import { fastagentVersion } from "../version.ts";
import {
  type BuiltDefinition,
  type Unfinished,
  assertNoMcpToolConflicts,
  buildDefinition,
  resolveDefaultModel,
} from "./assembly.ts";
import {
  agentPresentation,
  diagnoseHarnessCompatibility,
  resolveCodingTools,
  resolveHarnessSelection,
} from "./config.ts";
import type { AgentConfig, HarnessName, SandboxMode } from "./define.ts";
import { resolveHarnessProvider } from "./harness-loader.ts";
import { mcpTools } from "./mcp.ts";
import { overlayCredentialStore } from "./models/credentials.ts";
import {
  type ManagedDurableCredentialStore,
  postgresDurableCredentialStore,
  sqliteDurableCredentialStore,
} from "./models/durable-credentials.ts";
import { type ModelEnvironment, modelEnvironment } from "./models/environment.ts";
import { type AuthManager, createAuthManager } from "./models/remote-auth.ts";
import { otlpTraces } from "./telemetry/otlp.ts";
import { readCommands, renderDefinitionPrompt } from "./text.ts";

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
  /** Runtime harness override (`--harness` / `FASTAGENT_HARNESS` / `fastagent.config.ts` / custom `HarnessProvider`). */
  harness?: HarnessName | HarnessProvider;
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

type ServingStorage = "instance" | { file: string; holders?: string } | "memory";

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
  /** Canonical in-process storage lock/lease key used to serialize close -> reopen handoffs. */
  readonly storageKey?: string;
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

/** The database the instance's storage is in: the one given, or the one `FASTAGENT_DATABASE_URL` names, or none. */
function databaseOf(place: InstancePlace): PostgresDatabase | undefined {
  if (place.database !== undefined) return place.database;
  const url = place.env[DATABASE_URL_ENV];
  return url ? { url } : undefined;
}

/**
 * In-process tracker of active `close()` / rollback teardowns keyed by canonical storage target.
 * Lets a same-process `openAgent()` wait for a just-evicted or handing-off handle to finish releasing its SQLite
 * lock or PostgreSQL lease instead of racing against itself.
 */
const inFlightCloses = new Map<string, Set<Promise<void>>>();

function canonicalPath(target: string): string {
  let current = resolve(target);
  const missing: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return missing.length === 0 ? real : join(real, ...missing.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return resolve(target);
      const parent = dirname(current);
      if (parent === current) return resolve(target);
      missing.push(basename(current));
      current = parent;
    }
  }
}

function storageKeyOf(
  chosen: ServingStorage,
  place: InstancePlace,
  rawDatabase: PostgresDatabase | undefined,
): string | undefined {
  if (chosen === "memory") return undefined;
  if (chosen !== "instance") return `sqlite:${canonicalPath(chosen.file)}`;
  if (rawDatabase !== undefined) {
    if (place.name === undefined) return undefined;
    return `pg:${describeDatabase(rawDatabase.url)}:${place.name}`;
  }
  return `sqlite:${canonicalPath(join(place.stateRoot, "agent.sqlite"))}`;
}

export function trackInFlightClose(key: string | undefined, closing: Promise<void>): void {
  if (key === undefined) return;
  let active = inFlightCloses.get(key);
  if (active === undefined) {
    active = new Set();
    inFlightCloses.set(key, active);
  }
  const settled = closing.then(
    () => undefined,
    () => undefined,
  );
  active.add(settled);
  void settled.finally(() => {
    active.delete(settled);
    if (active.size === 0 && inFlightCloses.get(key) === active) {
      inFlightCloses.delete(key);
    }
  });
}

async function awaitInFlightCloses(key: string | undefined): Promise<void> {
  if (key === undefined) return;
  for (;;) {
    const active = inFlightCloses.get(key);
    if (active === undefined || active.size === 0) return;
    await Promise.all([...active]);
  }
}

/** Where the instance's storage is, as a person reads it: the database (without credentials), or the file. */
export function describeInstanceStorage(place: InstancePlace): string {
  const url = databaseOf(place)?.url;
  if (!url) return join(place.stateRoot, "agent.sqlite");
  const instance = place.name === undefined ? `no instance: set ${INSTANCE_NAME_ENV}` : `instance "${place.name}"`;
  return `PostgreSQL ${describeDatabase(url)}, ${instance}`;
}

export async function runServingPromise<A>(effect: Effect.Effect<A, PromiseFailure>): Promise<A> {
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
  const directProvider =
    options.harness !== undefined && typeof options.harness !== "string" ? options.harness : undefined;
  const validatedDirectProvider =
    directProvider !== undefined
      ? yield* fromPromise(() => resolveHarnessProvider(directProvider, projectDir))
      : undefined;
  const rawSelection = yield* Effect.try({
    try: () =>
      resolveHarnessSelection(
        config,
        {
          ...(validatedDirectProvider !== undefined
            ? { harness: validatedDirectProvider.name }
            : typeof options.harness === "string"
              ? { harness: options.harness }
              : {}),
          ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
        },
        options.ownEnv,
        validatedDirectProvider === undefined
          ? undefined
          : { supportsSandbox: validatedDirectProvider.supportsSandbox === true },
      ),
    catch: (cause) => new PromiseFailure(cause),
  });
  const provider =
    validatedDirectProvider ?? (yield* fromPromise(() => resolveHarnessProvider(rawSelection.harness, projectDir)));
  const selection = yield* Effect.try({
    try: () => {
      if (rawSelection.sandbox !== undefined && provider.supportsSandbox !== true) {
        throw new Error(
          `sandbox (${JSON.stringify(rawSelection.sandbox)}) is not supported by harness "${provider.name}"`,
        );
      }
      if (rawSelection.sandbox === undefined && provider.supportsSandbox === true) {
        return { harness: provider.name, sandbox: "workspace" as const };
      }
      return rawSelection;
    },
    catch: (cause) => new PromiseFailure(cause),
  });
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
  const storageKey = storageKeyOf(chosen, place, rawDatabase);
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
    yield* fromPromise(() => awaitInFlightCloses(storageKey));

    // Both conversations and credentials are lazy-open (never creating files or running DDL until first write),
    // so acquiring them ahead of harness storage preserves clean LIFO teardown without touching disk on lock refusal.
    const conversations = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          chosen === "memory"
            ? memoryConversationStore()
            : chosen !== "instance"
              ? sqliteConversationStore(`${chosen.file}.conversations.sqlite`)
              : database !== undefined
                ? postgresConversationStore(database, place.name as string)
                : sqliteConversationStore(join(stateRoot, "conversations.sqlite")),
        catch: (cause) => new PromiseFailure(cause),
      }),
      (store) => release(() => store.close()),
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
    const codingTools = resolveCodingTools(config.codingTools);
    const presentation = agentPresentation(definition);
    const modelSpec = options.model ?? config.model;
    const { model: modelRef, unusableDefault } = yield* Effect.try({
      try: () => resolveDefaultModel(modelSpec, options.model !== undefined, models.models),
      catch: (cause) => new PromiseFailure(cause),
    });
    for (const warning of diagnoseHarnessCompatibility(definition, selection, {
      extensions: code.extensions,
      supportsExtensions: provider.supportsExtensions === true,
    })) {
      log.warn(`[fastagent] ${warning}`);
    }

    const closeSignal = createCloseSignal();
    let currentRuntime: HarnessRuntimeAgent | undefined;
    let currentClose: (() => Promise<void>) | undefined;
    let earlyLost: Error | undefined;

    const handoffInstance = (): void => {
      log.info(`[fastagent] handing off idle instance "${name}" to another process`);
      currentClose?.().catch((cause: unknown) =>
        log.warn(`[fastagent] handing off instance "${name}" failed: ${String(cause)}`),
      );
    };
    const stopOnLeaseLoss = (error: Error): void => {
      log.error(`[fastagent] ${error.message}: stopping its runs`);
      if (currentClose === undefined) {
        earlyLost = error;
        return;
      }
      currentClose().catch((cause: unknown) => log.warn(`[fastagent] stopping the runs failed: ${String(cause)}`));
    };

    const storage: HarnessStorageHandle = yield* Effect.acquireRelease(
      fromPromise(async () =>
        provider.openStorage({
          place,
          chosen,
          database,
          onLost: stopOnLeaseLoss,
          handoff: {
            canYield: () =>
              currentClose !== undefined && !closeSignal.isClosing() && work.active() === 0 && !currentRuntime?.busy(),
            onHandoff: handoffInstance,
          },
        }),
      ),
      (handle) => release(() => handle.close()),
    );
    if (chosen === "instance" && database !== undefined) {
      log.info(`[fastagent] storage: ${storageDescription}`);
    }

    const mcp = yield* Effect.acquireRelease(
      fromPromise(() => openMcpClients(resolveMcpServers(mcpServers, secrets, undefined, workdir, processEnv))),
      (clients) => release(() => clients.close()),
    );
    const bridgedMcpTools = yield* Effect.try({
      try: () => {
        const built = mcpTools(mcp.tools);
        assertNoMcpToolConflicts(code, built);
        return built;
      },
      catch: (cause) => new PromiseFailure(cause),
    });

    const runtimeAgent = yield* Effect.acquireRelease(
      fromPromise(() =>
        provider.openAgent({
          storage,
          definition,
          code,
          mcpTools: bridgedMcpTools,
          codingTools,
          presentation,
          name,
          workdir,
          stateRoot,
          selection,
          processEnv,
          models: models.models,
          ...(modelRef === undefined ? {} : { model: modelRef }),
          ...(unusableDefault === undefined ? {} : { unusableDefault }),
          runsAs: options.runsAs,
          ...(options.unfinished === undefined ? {} : { unfinished: options.unfinished }),
          ...(traces?.context === undefined ? {} : { telemetry: traces.context as HarnessTelemetryContext }),
          work,
          commands: () => readCommands(dir),
          renderSystemPrompt: () =>
            renderDefinitionPrompt(dir, {
              workdir,
              source: definition.source === true,
              runsAs: options.runsAs,
              codingTools,
            }),
        }),
      ),
      (agent) => release(() => agent.close()),
    );
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

    const closedGate = Promise.withResolvers<void>();
    runtimeAgent.subscribeClose?.(closeSignal.mark);
    closeSignal.subscribe(() => trackInFlightClose(storageKey, closedGate.promise));
    if (auth !== undefined) {
      closeSignal.subscribe(() => auth.close());
    }
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

    let wrappedClose: Promise<void> | undefined;
    const wrappedAgent: ServingAgent = {
      ...runtimeAgent,
      closed: closedGate.promise,
      ready: () => !closeSignal.isClosing(),
      subscribeClose: closeSignal.subscribe,
      close: () => {
        closeSignal.mark();
        if (wrappedClose === undefined) {
          wrappedClose = runServingPromise(closeAgentEffect());
          trackInFlightClose(storageKey, wrappedClose);
        }
        return wrappedClose;
      },
    };
    currentRuntime = runtimeAgent;
    currentClose = () => wrappedAgent.close();
    if (earlyLost !== undefined) {
      currentClose().catch((cause: unknown) => log.warn(`[fastagent] stopping the runs failed: ${String(cause)}`));
    }
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
      ...(storageKey === undefined ? {} : { storageKey }),
    } satisfies OpenedServing;
  }).pipe(
    Scope.provide(lifetime),
    Effect.onError(() => {
      const rollbackGate = Promise.withResolvers<void>();
      trackInFlightClose(storageKey, rollbackGate.promise);
      return Scope.close(lifetime, Exit.void).pipe(Effect.ensuring(Effect.sync(() => rollbackGate.resolve())));
    }),
  );
});

export function openServing(definition: AgentDefinition, options: OpenServingOptions): Promise<OpenedServing> {
  return runServingPromise(openServingEffect(definition, options));
}
