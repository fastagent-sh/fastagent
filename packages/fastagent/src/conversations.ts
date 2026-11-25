/**
 * Harness-neutral caller-conversation mapping and single-call invoker (`POST /v1/invoke`, `agent.invoke`).
 * Keeps conversation-name and ephemeral idempotency-key session bindings outside every harness (SQLite via
 * `node:sqlite`, shared PostgreSQL / Aurora DSQL, or in-memory), delegating execution purely through the standard
 * `Agent` API.
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import {
  type Agent,
  AgentError,
  type ConversationId,
  type DecodedInvokeRequest,
  type IdempotencyKey,
  type InvokeApi,
  InvokeRequest,
  type Message,
  type MessageStreamEvent,
  type SendRequest,
  SessionId,
  type SessionSettings,
  type WaitOptions,
  agentError,
  decodeRequest,
} from "@fastagent-sh/client/agent-api";
import { openPostgresStore, openSqliteStore } from "./instance-store.ts";
import { log } from "./log.ts";
import type { PostgresDatabase } from "./postgres.ts";

interface ConversationSetOptions {
  /** Ephemeral idempotency bindings expire after a bounded TTL; caller-named conversations are retained durably. */
  readonly ephemeral?: boolean;
}

/** Internal storage key for a caller conversation or ephemeral idempotency binding; distinct from `SessionId`. */
export const ConversationKey = Schema.String.pipe(Schema.brand("ConversationKey"));
export type ConversationKey = typeof ConversationKey.Type;

/** Derive a durable conversation storage key from a caller-owned `ConversationId`. */
export const conversationStorageKey = (prefix: string, conversation: ConversationId): ConversationKey =>
  ConversationKey.make(`${prefix}c:${conversation}`);

/** Derive an ephemeral storage key from a caller-owned `IdempotencyKey`. */
export const idempotencyStorageKey = (prefix: string, key: IdempotencyKey): ConversationKey =>
  ConversationKey.make(`${prefix}i:${key}`);

export interface ConversationStore {
  get(key: ConversationKey): Promise<SessionId | undefined>;
  set(key: ConversationKey, sessionId: SessionId, options?: ConversationSetOptions): Promise<void>;
  close(): Promise<void>;
}

/** Effect-native conversation store reading timestamps from Effect `Clock` (testable directly with `TestClock`). */
export interface EffectConversationStore {
  get(key: ConversationKey): Effect.Effect<SessionId | undefined, AgentError>;
  set(key: ConversationKey, sessionId: SessionId, options?: ConversationSetOptions): Effect.Effect<void, AgentError>;
  readonly close: Effect.Effect<void, AgentError>;
}

interface ConversationStoreOptions {
  /** Retention window for ephemeral `Idempotency-Key` bindings (default: 24 hours). */
  readonly ephemeralTtlMs?: number;
  /** Maximum ephemeral entries kept in memory before evicting oldest (default: 10,000). */
  readonly maxEphemeral?: number;
  /** Optional Effect `Clock` override for Promise facades (Effect callers inherit ambient `Clock`). */
  readonly clock?: Clock.Clock;
}

const DEFAULT_EPHEMERAL_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_EPHEMERAL = 10_000;
const PG_PRUNE_INTERVAL_MS = 60_000;

const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS fastagent_conversations (
  name       TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  ephemeral  INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
`;

const PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS fastagent_conversations (
  instance   TEXT NOT NULL,
  name       TEXT NOT NULL,
  session_id TEXT NOT NULL,
  ephemeral  BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (instance, name)
);
`;

function asAgentError(operation: string, error: unknown): AgentError {
  if (error instanceof AgentError) return error;
  return agentError("internal", `${operation}: ${error instanceof Error ? error.message : String(error)}`);
}

function toPromiseStore(store: EffectConversationStore, clock?: Clock.Clock): ConversationStore {
  const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
    Effect.runPromise(clock === undefined ? effect : Effect.provideService(effect, Clock.Clock, clock));
  return {
    get: (key) => run(store.get(key)),
    set: (key, sessionId, options) => run(store.set(key, sessionId, options)),
    close: () => run(store.close),
  };
}

export function memoryConversationStoreEffect(options: ConversationStoreOptions = {}): EffectConversationStore {
  const ttlMs = options.ephemeralTtlMs ?? DEFAULT_EPHEMERAL_TTL_MS;
  const maxEphemeral = options.maxEphemeral ?? DEFAULT_MAX_EPHEMERAL;
  const named = new Map<ConversationKey, SessionId>();
  const ephemeral = new Map<ConversationKey, { sessionId: SessionId; expiresAt: number }>();

  const pruneEphemeral = (current: number): void => {
    for (const [k, entry] of ephemeral) {
      if (entry.expiresAt <= current) ephemeral.delete(k);
    }
    while (ephemeral.size > maxEphemeral) {
      const oldest = ephemeral.keys().next().value;
      if (oldest === undefined) break;
      ephemeral.delete(oldest);
    }
  };

  return {
    get: Effect.fn("conversations.memory.get")(function* (key: ConversationKey) {
      const durable = named.get(key);
      if (durable !== undefined) return durable;
      const entry = ephemeral.get(key);
      if (entry === undefined) return undefined;
      const current = yield* Clock.currentTimeMillis;
      if (entry.expiresAt <= current) {
        ephemeral.delete(key);
        return undefined;
      }
      return entry.sessionId;
    }),
    set: Effect.fn("conversations.memory.set")(function* (
      key: ConversationKey,
      sessionId: SessionId,
      setOptions?: ConversationSetOptions,
    ) {
      if (setOptions?.ephemeral) {
        const current = yield* Clock.currentTimeMillis;
        ephemeral.delete(key);
        ephemeral.set(key, { sessionId, expiresAt: current + ttlMs });
        pruneEphemeral(current);
        return;
      }
      ephemeral.delete(key);
      named.set(key, sessionId);
    }),
    close: Effect.void,
  };
}

export function memoryConversationStore(options: ConversationStoreOptions = {}): ConversationStore {
  return toPromiseStore(memoryConversationStoreEffect(options), options.clock);
}

export function sqliteConversationStoreEffect(
  filePath: string,
  options: ConversationStoreOptions = {},
): EffectConversationStore {
  const ttlMs = options.ephemeralTtlMs ?? DEFAULT_EPHEMERAL_TTL_MS;
  const store = openSqliteStore(filePath, SQLITE_SCHEMA, { journalMode: "WAL" });
  const selectStmt = store.db.prepare(
    "SELECT session_id, ephemeral, updated_at FROM fastagent_conversations WHERE name = ?",
  );
  const upsertStmt = store.db.prepare(
    `INSERT INTO fastagent_conversations (name, session_id, ephemeral, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       session_id = excluded.session_id,
       ephemeral = excluded.ephemeral,
       updated_at = excluded.updated_at`,
  );
  const pruneStmt = store.db.prepare("DELETE FROM fastagent_conversations WHERE ephemeral = 1 AND updated_at <= ?");
  return {
    get: Effect.fn("conversations.sqlite.get")(function* (key: ConversationKey) {
      const row = yield* Effect.try({
        try: () => selectStmt.get(key) as { session_id?: string; ephemeral?: number; updated_at?: number } | undefined,
        catch: (error) => asAgentError("conversations.sqlite.get", error),
      });
      if (row?.session_id === undefined) return undefined;
      const current = yield* Clock.currentTimeMillis;
      if (row.ephemeral === 1 && (row.updated_at ?? 0) <= current - ttlMs) return undefined;
      return SessionId.make(row.session_id);
    }),
    set: Effect.fn("conversations.sqlite.set")(function* (
      key: ConversationKey,
      sessionId: SessionId,
      setOptions?: ConversationSetOptions,
    ) {
      const current = yield* Clock.currentTimeMillis;
      const isEphemeral = setOptions?.ephemeral === true ? 1 : 0;
      yield* Effect.try({
        try: () => {
          upsertStmt.run(key, sessionId, isEphemeral, current);
        },
        catch: (error) => asAgentError("conversations.sqlite.set", error),
      });
      if (isEphemeral === 1) {
        yield* Effect.try({
          try: () => {
            pruneStmt.run(current - ttlMs);
          },
          catch: (error) => asAgentError("conversations.sqlite.prune", error),
        }).pipe(
          Effect.catch((pruneError) =>
            Effect.sync(() =>
              log.warn(`[fastagent] pruning expired ephemeral conversations failed: ${String(pruneError)}`),
            ),
          ),
        );
      }
    }),
    close: Effect.tryPromise({
      try: () => store.close(),
      catch: (error) => asAgentError("conversations.sqlite.close", error),
    }).pipe(Effect.withSpan("conversations.sqlite.close")),
  };
}

export function sqliteConversationStore(filePath: string, options: ConversationStoreOptions = {}): ConversationStore {
  return toPromiseStore(sqliteConversationStoreEffect(filePath, options), options.clock);
}

function postgresConversationStoreEffect(
  database: PostgresDatabase,
  instance: string,
  options: ConversationStoreOptions = {},
): EffectConversationStore {
  const ttlMs = options.ephemeralTtlMs ?? DEFAULT_EPHEMERAL_TTL_MS;
  const store = openPostgresStore(database, PG_SCHEMA, "conversation store");
  const lastPrunedAt = Ref.makeUnsafe(0);

  return {
    get: Effect.fn("conversations.postgres.get")(function* (key: ConversationKey) {
      const rows = yield* Effect.tryPromise({
        try: () =>
          store.query<{ session_id: string; ephemeral: boolean; updated_at: number }>(
            "SELECT session_id, ephemeral, updated_at FROM fastagent_conversations WHERE instance = $1 AND name = $2",
            [instance, key],
          ),
        catch: (error) => asAgentError("conversations.postgres.get", error),
      });
      const row = rows[0];
      if (row === undefined) return undefined;
      const current = yield* Clock.currentTimeMillis;
      if (row.ephemeral && Number(row.updated_at) <= current - ttlMs) return undefined;
      return SessionId.make(row.session_id);
    }),
    set: Effect.fn("conversations.postgres.set")(function* (
      key: ConversationKey,
      sessionId: SessionId,
      setOptions?: ConversationSetOptions,
    ) {
      const current = yield* Clock.currentTimeMillis;
      const isEphemeral = setOptions?.ephemeral === true;
      yield* Effect.tryPromise({
        try: () =>
          store.query(
            `INSERT INTO fastagent_conversations (instance, name, session_id, ephemeral, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (instance, name) DO UPDATE SET
           session_id = EXCLUDED.session_id,
           ephemeral = EXCLUDED.ephemeral,
           updated_at = EXCLUDED.updated_at`,
            [instance, key, sessionId, isEphemeral, current],
          ),
        catch: (error) => asAgentError("conversations.postgres.set", error),
      });
      const shouldPrune =
        isEphemeral &&
        (yield* Ref.modify(lastPrunedAt, (last) =>
          current - last >= PG_PRUNE_INTERVAL_MS ? ([true, current] as const) : ([false, last] as const),
        ));
      if (shouldPrune) {
        yield* Effect.tryPromise({
          try: () =>
            store.query(
              "DELETE FROM fastagent_conversations WHERE instance = $1 AND ephemeral = TRUE AND updated_at <= $2",
              [instance, current - ttlMs],
            ),
          catch: (error) => asAgentError("conversations.postgres.prune", error),
        }).pipe(
          Effect.catch((pruneError) =>
            Effect.sync(() =>
              log.warn(`[fastagent] pruning expired ephemeral conversations failed: ${String(pruneError)}`),
            ),
          ),
        );
      }
    }),
    close: Effect.tryPromise({
      try: () => store.close(),
      catch: (error) => asAgentError("conversations.postgres.close", error),
    }).pipe(Effect.withSpan("conversations.postgres.close")),
  };
}

export function postgresConversationStore(
  database: PostgresDatabase,
  instance: string,
  options: ConversationStoreOptions = {},
): ConversationStore {
  return toPromiseStore(postgresConversationStoreEffect(database, instance, options), options.clock);
}

function sendPayload(sessionId: SessionId, request: DecodedInvokeRequest): SendRequest {
  return {
    sessionId,
    content: request.content,
    ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
    ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
    ...(request.whenBusy === undefined ? {} : { whenBusy: request.whenBusy }),
  };
}

export function createInvoker(
  agent: Agent,
  store: ConversationStore,
  options: { readonly keyPrefix?: string } = {},
): InvokeApi {
  const prefix = options.keyPrefix ?? "";
  const locks = new Map<ConversationKey, Promise<unknown>>();
  const serialized = <T>(key: ConversationKey, work: () => Promise<T>): Promise<T> => {
    const prev = locks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(work);
    const tracked = next.finally(() => {
      if (locks.get(key) === tracked) locks.delete(key);
    });
    locks.set(key, tracked);
    return next;
  };

  const checkSignal = (signal: AbortSignal | undefined): void => {
    if (signal?.aborted) throw signal.reason;
  };

  const createAndRecord = async (
    key: ConversationKey,
    title: string | undefined,
    settings: SessionSettings | undefined,
    ephemeral: boolean,
    signal: AbortSignal | undefined,
  ): Promise<SessionId> => {
    checkSignal(signal);
    const created = await agent.sessions.create({
      ...(title === undefined ? {} : { title }),
      ...settings,
    });
    await store.set(key, created.id, { ephemeral });
    return created.id;
  };

  const resolveKeyed = (
    key: ConversationKey,
    title: string | undefined,
    settings: SessionSettings | undefined,
    ephemeral: boolean,
    signal: AbortSignal | undefined,
  ): Promise<SessionId> =>
    serialized(key, async () => {
      checkSignal(signal);
      const existing = await store.get(key);
      if (existing !== undefined) {
        checkSignal(signal);
        try {
          if (settings !== undefined) await agent.sessions.update(existing, settings);
          else await agent.sessions.get(existing);
          return existing;
        } catch (error) {
          if (!(error instanceof AgentError && error.code === "not_found")) throw error;
        }
      }
      return createAndRecord(key, title, settings, ephemeral, signal);
    });

  const resolveSessionId = async (
    request: DecodedInvokeRequest,
    signal: AbortSignal | undefined,
  ): Promise<SessionId> => {
    checkSignal(signal);
    if (request.sessionId !== undefined) {
      if (request.session !== undefined) {
        await agent.sessions.update(request.sessionId, request.session);
      }
      return request.sessionId;
    }
    if (request.conversation !== undefined) {
      return resolveKeyed(
        conversationStorageKey(prefix, request.conversation),
        request.conversation,
        request.session,
        false,
        signal,
      );
    }
    if (request.idempotencyKey !== undefined) {
      return resolveKeyed(
        idempotencyStorageKey(prefix, request.idempotencyKey),
        undefined,
        request.session,
        true,
        signal,
      );
    }
    return (await agent.sessions.create(request.session)).id;
  };

  return {
    async invoke(raw: InvokeRequest, options?: WaitOptions): Promise<Message> {
      checkSignal(options?.signal);
      const request = decodeRequest(InvokeRequest, raw, "invoke");
      const sessionId = await resolveSessionId(request, options?.signal);
      checkSignal(options?.signal);
      return agent.messages.send(sendPayload(sessionId, request), options);
    },
    invokeStream(raw: InvokeRequest, options?: { signal?: AbortSignal }): AsyncIterable<MessageStreamEvent> {
      async function* stream(): AsyncGenerator<MessageStreamEvent> {
        checkSignal(options?.signal);
        const request = decodeRequest(InvokeRequest, raw, "invoke");
        const sessionId = await resolveSessionId(request, options?.signal);
        checkSignal(options?.signal);
        yield* agent.messages.stream(sendPayload(sessionId, request), options);
      }
      return stream();
    },
  };
}
