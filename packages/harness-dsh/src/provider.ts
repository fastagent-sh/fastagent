/**
 * `HarnessProvider` implementation for `@fastagent-sh/harness-dsh` (`@fastagent-sh/harness-dsh/provider`).
 * Loaded lazily by `@fastagent-sh/fastagent` when `harness: "dsh"` is selected; owns DSH SQLite/PostgreSQL/memory
 * event store creation and `openDshAgent` assembly while `@fastagent-sh/fastagent` manages MCP, auth, and teardown.
 */
import { join } from "node:path";
import {
  DEFAULT_LEASE_WAIT_MS,
  INSTANCE_NAME_ENV,
  InstanceHeld,
  Unavailable,
  adaptToolRejectingPark,
  describeDatabase,
  isTransientPgError,
  sharedHandleOf,
  type HarnessAgentOpenContext,
  type HarnessProvider,
  type HarnessRuntimeAgent,
  type HarnessStorageHandle,
  type HarnessStorageOpenContext,
} from "@fastagent-sh/fastagent/harness";
import { openDshAgent } from "./agent.ts";
import { MemoryDshEventStore } from "./persistence.ts";
import { openPostgresDshStore } from "./postgres-store.ts";
import { openSqliteDshStore } from "./sqlite-store.ts";
import type { DshEventStoreBackend } from "./types.ts";

const NAMED_INSTANCE_HOLDERS =
  "another `fastagent dev` or `start` command of an instance of this name, on this machine or another";

interface DshStorageHandle extends HarnessStorageHandle {
  readonly store: DshEventStoreBackend;
}

function openSqliteHandle(filePath: string): DshStorageHandle {
  try {
    const store = openSqliteDshStore(filePath);
    return { store, close: () => store.close() };
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

export const harnessProvider: HarnessProvider<DshStorageHandle> = {
  name: "dsh",
  supportsExtensions: false,

  async openStorage(ctx: HarnessStorageOpenContext): Promise<DshStorageHandle> {
    if (ctx.chosen === "memory") {
      return { store: new MemoryDshEventStore(), close: () => {} };
    }
    if (ctx.chosen !== "instance") {
      return openSqliteHandle(ctx.chosen.file);
    }
    if (ctx.database !== undefined) {
      if (ctx.place.name === undefined) {
        throw new Error(
          `an instance in a database is opened by its name, and none was given: set ${INSTANCE_NAME_ENV} (an app: openAgent's name)`,
        );
      }
      const shared = sharedHandleOf(ctx.database);
      if (shared === undefined) {
        throw new Error("DSH PostgreSQL storage requires a SharedPostgresDatabase handle");
      }
      shared.assertOpen();
      try {
        const store = await openPostgresDshStore(shared.borrowed, ctx.place.name, {
          pool: shared,
          waitMs: DEFAULT_LEASE_WAIT_MS,
          holders: NAMED_INSTANCE_HOLDERS,
          handoff: ctx.handoff,
          onLost: ctx.onLost,
          ...(ctx.database.createIndex === undefined ? {} : { createIndex: ctx.database.createIndex }),
          ...(ctx.database.limits === undefined ? {} : { limits: ctx.database.limits }),
        });
        if (shared.isClosed()) {
          await store.close().catch(() => {});
          shared.assertOpen();
        }
        return { store, close: () => store.close() };
      } catch (error) {
        if (error instanceof InstanceHeld || shared.isClosed()) throw error;
        const failed = isTransientPgError(error) ? Unavailable : Error;
        throw new failed(`the database ${describeDatabase(ctx.database.url)}: ${(error as Error).message}`, {
          cause: error,
        });
      }
    }
    return openSqliteHandle(join(ctx.place.stateRoot, "agent.sqlite"));
  },

  async openAgent(ctx: HarnessAgentOpenContext<DshStorageHandle>): Promise<HarnessRuntimeAgent> {
    const { config } = ctx.definition;
    const dshAgent = await openDshAgent({
      name: ctx.name,
      agent: ctx.presentation.agent,
      ...(ctx.presentation.starters === undefined ? {} : { starters: ctx.presentation.starters }),
      workdir: ctx.workdir,
      systemPrompt: ctx.renderSystemPrompt,
      models: ctx.models,
      ...(ctx.model === undefined ? {} : { model: ctx.model }),
      ...(ctx.unusableDefault === undefined ? {} : { unusableDefault: ctx.unusableDefault }),
      ...(config.thinkingLevel === undefined ? {} : { thinkingLevel: config.thinkingLevel }),
      tools: [...ctx.code.tools, ...ctx.mcpTools].map(adaptToolRejectingPark),
      codingTools: ctx.codingTools,
      protectedPaths: [ctx.stateRoot],
      env: ctx.processEnv,
      commands: ctx.commands,
      sandbox: ctx.selection.sandbox ?? "workspace",
      ...(ctx.unfinished === undefined ? {} : { unfinished: ctx.unfinished }),
      ...(ctx.maxMessageBytes === undefined ? {} : { maxMessageBytes: ctx.maxMessageBytes }),
      ...(ctx.telemetry === undefined ? {} : { telemetry: ctx.telemetry }),
      storage: ctx.storage.store,
    });

    return {
      info: dshAgent.info,
      usage: dshAgent.usage,
      sessions: dshAgent.sessions,
      messages: dshAgent.messages,
      busy: () => dshAgent.busy(),
      close: () => dshAgent.close(),
    };
  },
};
