/**
 * `@fastagent-sh/harness-dsh` runtime adapter plugged into `harnesses/serving.ts`.
 * Loads `@fastagent-sh/harness-dsh` lazily so `@fastagent-sh/fastagent` carries zero dependency on
 * `@deepseek-ai/*`, shares `agent.sqlite` / PostgreSQL via `dsh_*` tables, forwards the sanitized
 * `processEnv` to sandboxed `bash` commands, and warns-and-skips `pi-durable`-only `src/extensions/*`.
 */
import { join } from "node:path";
import type { Agent, ModelRef } from "@fastagent-sh/client/agent-api";
import type { Models } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { createCloseSignal } from "../../close-signal.ts";
import { INSTANCE_NAME_ENV } from "../../instance-name.ts";
import { log } from "../../log.ts";
import type { McpClients } from "../../mcp/client.ts";
import {
  type CreateIndex,
  type PgDatabase,
  type PgExecutor,
  type PostgresDatabase,
  type PostgresLimits,
  acquirePgDatabase,
  describeDatabase,
  isTransientPgError,
  sharedHandleOf,
} from "../../postgres.ts";
import {
  DEFAULT_LEASE_WAIT_MS,
  InstanceHeld,
  type PgInstanceLease,
  acquirePgInstanceLease,
  isPgConflict,
  migratePgSchema,
  splitPgText,
} from "../../postgres-kit.ts";
import { Unavailable } from "../../unavailable.ts";
import { assertNoMcpToolConflicts, resolveDefaultModel } from "../assembly.ts";
import { OPTIONAL_HARNESS_PACKAGES, agentPresentation, resolveCodingTools } from "../config.ts";
import { mcpTools } from "../mcp.ts";
import { readCommands, renderDefinitionPrompt } from "../text.ts";
import type { HarnessOpenContext, InstancePlace, ServingAgent } from "../serving.ts";

const DSH_PACKAGE_NAME = OPTIONAL_HARNESS_PACKAGES.dsh;

/** Adapt pi-durable ToolRegistration for DSH: fail visibly if a tool returns a pi-durable-only park (sleep/wait). */
function adaptToolForDsh(tool: ToolRegistration): ToolRegistration {
  return {
    ...tool,
    execute: async (args, api, context) => {
      const result = await tool.execute(args, api, context);
      if (result !== null && typeof result === "object" && ("sleep" in result || "wait" in result)) {
        throw new Error(
          `tool "${tool.name}" returned a park response (sleep/wait), which requires harness: "pi-durable"`,
        );
      }
      return result;
    },
  };
}

interface DshStorageBackend {
  close?(): Promise<void>;
}

export interface DshModule {
  MemoryDshEventStore: new () => DshStorageBackend;
  openSqliteDshStore(
    filePath: string,
    options?: { readonly busyTimeoutMs?: number },
  ): DshStorageBackend & { close(): Promise<void> };
  openPostgresDshStore(
    database: PgDatabase,
    instance: string,
    options?: {
      readonly waitMs?: number;
      readonly onLost?: (error: Error) => void;
      readonly createIndex?: CreateIndex;
      readonly limits?: PostgresLimits;
      readonly kit?: {
        readonly migrate?: (
          db: PgDatabase,
          statements: readonly string[],
          options: {
            readonly createIndex?: CreateIndex;
            readonly version?: { readonly table: string; readonly current: number };
          },
        ) => Promise<void>;
        readonly acquireLease?: (
          db: PgDatabase,
          options: {
            readonly table: string;
            readonly instance: string;
            readonly owner?: string;
            readonly leaseMs?: number;
            readonly waitMs?: number;
            readonly onLost?: (error: Error) => void;
            readonly onTake?: (tx: PgExecutor, owner: string) => Promise<void>;
            readonly formatHeldError?: (info: {
              readonly instance: string;
              readonly until: string;
              readonly holder?: string;
            }) => Error;
            readonly formatLostError?: (instance: string) => Error;
          },
        ) => Promise<Pick<PgInstanceLease<void>, "owner" | "lost" | "lose" | "release">>;
        readonly splitText?: (text: string, bytesPerValue: number | undefined) => string[] | undefined;
        readonly isConflict?: (error: unknown) => boolean;
      };
    },
  ): Promise<DshStorageBackend & { close(): Promise<void> }>;
  openDshAgent(options: {
    readonly name: string;
    readonly agent?: { readonly name: string; readonly description?: string };
    readonly starters?: readonly string[];
    readonly workdir: string;
    readonly systemPrompt?: string | (() => string | undefined);
    readonly models?: Models;
    readonly model?: ModelRef;
    readonly unusableDefault?: { readonly spec: string; readonly reason: string };
    readonly thinkingLevel?: string;
    readonly tools?: readonly unknown[];
    readonly codingTools?: boolean | readonly ("read" | "write" | "edit" | "bash")[];
    readonly protectedPaths?: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
    readonly commands?: () => readonly {
      readonly name: string;
      readonly description?: string;
      expand(args: string): string;
    }[];
    readonly sandbox?: "workspace" | "read-only" | "off";
    readonly unfinished?: "resume" | "refuse";
    readonly maxMessageBytes?: number;
    readonly telemetry?: unknown;
    readonly storage?: DshStorageBackend;
  }): Promise<Agent & { busy(): boolean; close(): Promise<void> }>;
}

export async function loadDshModule(): Promise<DshModule> {
  try {
    return (await import(DSH_PACKAGE_NAME)) as unknown as DshModule;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
      throw new Error(
        `harness "dsh" requires ${DSH_PACKAGE_NAME}. Install it in your project: npm install ${DSH_PACKAGE_NAME}`,
        { cause: error },
      );
    }
    throw error;
  }
}

function openSqliteWithHelpfulLockError(
  dsh: DshModule,
  filePath: string,
): DshStorageBackend & { close(): Promise<void> } {
  try {
    return dsh.openSqliteDshStore(filePath);
  } catch (error) {
    const errcode = (error as { errcode?: unknown }).errcode;
    const msg = error instanceof Error ? error.message : String(error);
    if (errcode === 5 || msg.includes("database is locked")) {
      throw new Error(
        `the storage ${filePath} is held by another process: another fastagent dev or start command is running. Stop that one first`,
        { cause: error },
      );
    }
    throw error;
  }
}

async function openInstanceDshStore(
  dsh: DshModule,
  place: InstancePlace,
  database: PostgresDatabase | undefined,
  onLost?: (error: Error) => void,
): Promise<{ store: DshStorageBackend & { close(): Promise<void> }; ownedPgClose?: () => Promise<void> }> {
  if (database !== undefined) {
    if (place.name === undefined) {
      throw new Error(
        `an instance in a database is opened by its name, and none was given: set ${INSTANCE_NAME_ENV} (an app: openAgent's name)`,
      );
    }
    const shared = sharedHandleOf(database);
    const acquired = acquirePgDatabase(database);
    const ownedPgClose = acquired.owned ? () => acquired.db.close() : undefined;
    const kit = {
      migrate: async (
        db: PgDatabase,
        statements: readonly string[],
        opts: {
          readonly createIndex?: CreateIndex;
          readonly version?: { readonly table: string; readonly current: number };
        },
      ) => {
        if (shared !== undefined) {
          await shared.ensureMigrated("dsh", (sharedDb) => migratePgSchema(sharedDb, statements, opts));
          return;
        }
        await migratePgSchema(db, statements, opts);
      },
      acquireLease: (
        db: PgDatabase,
        opts: {
          readonly table: string;
          readonly instance: string;
          readonly owner?: string;
          readonly leaseMs?: number;
          readonly waitMs?: number;
          readonly onLost?: (error: Error) => void;
          readonly onTake?: (tx: PgExecutor, owner: string) => Promise<void>;
          readonly formatHeldError?: (info: {
            readonly instance: string;
            readonly until: string;
            readonly holder?: string;
          }) => Error;
          readonly formatLostError?: (instance: string) => Error;
        },
      ) => acquirePgInstanceLease(db, opts),
      splitText: splitPgText,
      isConflict: isPgConflict,
    };
    try {
      const store = await dsh.openPostgresDshStore(acquired.db, place.name, {
        waitMs: DEFAULT_LEASE_WAIT_MS,
        ...(onLost === undefined ? {} : { onLost }),
        ...(database.createIndex === undefined ? {} : { createIndex: database.createIndex }),
        ...(database.limits === undefined ? {} : { limits: database.limits }),
        kit,
      });
      if (shared?.isClosed()) {
        await store.close().catch(() => {});
        shared.assertOpen();
      }
      return ownedPgClose === undefined ? { store } : { store, ownedPgClose };
    } catch (error) {
      await ownedPgClose?.().catch(() => {});
      if (error instanceof InstanceHeld || shared?.isClosed()) throw error;
      if (error instanceof Error && error.name === "DshInstanceHeldError") {
        throw new InstanceHeld(error.message, { cause: error });
      }
      const failed = isTransientPgError(error) ? Unavailable : Error;
      throw new failed(`the database ${describeDatabase(database.url)}: ${(error as Error).message}`, { cause: error });
    }
  }
  return { store: openSqliteWithHelpfulLockError(dsh, join(place.stateRoot, "agent.sqlite")) };
}

export async function openDshRuntime(ctx: HarnessOpenContext, preloaded?: DshModule): Promise<ServingAgent> {
  const dsh = preloaded ?? (await loadDshModule());
  const {
    definition,
    options,
    selection,
    name,
    workdir,
    stateRoot,
    chosen,
    place,
    database,
    maxMessageBytes,
    storageDescription,
    processEnv,
    code,
    models,
    traces,
  } = ctx;
  const { dir, config } = definition;

  if (code.extensions.length > 0) {
    const skipped = code.extensions.map((ext) => ext.name).join(", ");
    log.warn(
      `[fastagent] skipping pi-durable extensions on harness "dsh": ${skipped} (portable tools belong in src/tools/)`,
    );
  }

  const codingTools = resolveCodingTools(config.codingTools);
  const presentation = agentPresentation(definition);
  const modelSpec = options.model ?? config.model;
  const { model: modelRef, unusableDefault } = resolveDefaultModel(
    modelSpec,
    options.model !== undefined,
    models.models,
  );

  let stopRuns: ((error: Error) => void) | undefined;
  let store: DshStorageBackend;
  let ownedPgClose: (() => Promise<void>) | undefined;
  if (chosen === "memory") {
    store = new dsh.MemoryDshEventStore();
  } else if (chosen !== "instance") {
    store = openSqliteWithHelpfulLockError(dsh, chosen.file);
  } else {
    const opened = await openInstanceDshStore(dsh, place, database, (error) => stopRuns?.(error));
    store = opened.store;
    ownedPgClose = opened.ownedPgClose;
    if (database !== undefined) log.info(`[fastagent] storage: ${storageDescription}`);
  }

  let mcp: McpClients | undefined;
  let dshAgent: Agent & { busy(): boolean; close(): Promise<void> };
  try {
    mcp = await ctx.openMcp();
    const bridgedMcpTools = mcpTools(mcp.tools);
    assertNoMcpToolConflicts(code, bridgedMcpTools);
    dshAgent = await dsh.openDshAgent({
      name,
      agent: presentation.agent,
      ...(presentation.starters === undefined ? {} : { starters: presentation.starters }),
      workdir,
      systemPrompt: () =>
        renderDefinitionPrompt(dir, {
          workdir,
          source: definition.source === true,
          runsAs: options.runsAs,
          codingTools,
        }),
      models: models.models,
      ...(modelRef === undefined ? {} : { model: modelRef }),
      ...(unusableDefault === undefined ? {} : { unusableDefault }),
      ...(config.thinkingLevel === undefined ? {} : { thinkingLevel: config.thinkingLevel }),
      tools: [...code.tools, ...bridgedMcpTools].map(adaptToolForDsh),
      codingTools,
      protectedPaths: [stateRoot],
      env: processEnv,
      commands: () => readCommands(dir),
      sandbox: selection.sandbox ?? "workspace",
      ...(options.unfinished === undefined ? {} : { unfinished: options.unfinished }),
      ...(maxMessageBytes === undefined ? {} : { maxMessageBytes }),
      ...(traces === undefined ? {} : { telemetry: traces.context }),
      storage: store,
    });
  } catch (error) {
    const failures: unknown[] = [error];
    if (mcp) await mcp.close().catch((cleanup: unknown) => failures.push(cleanup));
    await store.close?.().catch((cleanup: unknown) => failures.push(cleanup));
    await ownedPgClose?.().catch((cleanup: unknown) => failures.push(cleanup));
    await traces?.close();
    throw failures.length === 1 ? error : new AggregateError(failures, "DSH agent open and cleanup failed");
  }

  const closeSignal = createCloseSignal();
  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });

  let closing: Promise<void> | undefined;
  const close = () => {
    closeSignal.mark();
    closing ??= (async () => {
      const failures: unknown[] = [];
      try {
        ctx.closeAuth();
        await dshAgent.close().catch((error: unknown) => failures.push(error));
        await mcp?.close().catch((error: unknown) => failures.push(error));
        await store.close?.().catch((error: unknown) => failures.push(error));
        await ownedPgClose?.().catch((error: unknown) => failures.push(error));
        await traces?.close();
      } finally {
        markClosed();
      }
      if (failures.length > 0) throw new AggregateError(failures, "DSH agent close failed");
    })();
    return closing;
  };

  stopRuns = (error) => {
    log.error(`[fastagent] ${error.message}: stopping its runs`);
    close().catch((cause: unknown) => log.warn(`[fastagent] stopping the runs failed: ${String(cause)}`));
  };

  return {
    info: dshAgent.info,
    usage: dshAgent.usage,
    sessions: dshAgent.sessions,
    messages: dshAgent.messages,
    closed,
    ready: () => !closeSignal.isClosing(),
    subscribeClose: closeSignal.subscribe,
    busy: () => dshAgent.busy(),
    close,
  };
}
