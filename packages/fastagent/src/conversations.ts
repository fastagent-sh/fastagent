/**
 * Harness-neutral caller-conversation mapping and single-call invoker (`POST /v1/invoke`, `agent.invoke`).
 * Keeps conversation-name and ephemeral idempotency-key session bindings outside every harness (SQLite via
 * `node:sqlite`, shared PostgreSQL / Aurora DSQL, or in-memory), delegating execution purely through the standard
 * `Agent` API.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as Schema from "effect/Schema";
import {
  type Agent,
  AgentError,
  type InvokeApi,
  InvokeRequest,
  type Message,
  type MessageStreamEvent,
  type SendRequest,
  type SessionSettings,
  type WaitOptions,
  agentError,
} from "@fastagent-sh/client/agent-api";
import { type PostgresDatabase, acquirePgDatabase } from "./postgres.ts";

interface ConversationSetOptions {
  /** Ephemeral idempotency bindings expire after a bounded TTL; caller-named conversations are retained durably. */
  readonly ephemeral?: boolean;
}

export interface ConversationStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, sessionId: string, options?: ConversationSetOptions): Promise<void>;
  close(): Promise<void>;
}

interface ConversationStoreOptions {
  /** Retention window for ephemeral `Idempotency-Key` bindings (default: 24 hours). */
  readonly ephemeralTtlMs?: number;
  /** Maximum ephemeral entries kept in memory before evicting oldest (default: 10,000). */
  readonly maxEphemeral?: number;
  readonly now?: () => number;
}

const DEFAULT_EPHEMERAL_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_EPHEMERAL = 10_000;
const PG_PRUNE_INTERVAL_MS = 60_000;

const PG_CONCURRENT_DDL = new Set(["42P07", "42710", "23505"]);

function isTransientPgError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === "string") {
    if (["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE"].includes(code)) return true;
    if (
      code.startsWith("08") ||
      code.startsWith("53") ||
      code === "40001" ||
      code === "40P01" ||
      code === "57P01" ||
      code === "57P02" ||
      code === "57P03" ||
      code === "OC000" ||
      code === "OC001"
    ) {
      return true;
    }
  }
  return error instanceof Error && /Connection terminated|timeout exceeded when trying to connect/.test(error.message);
}

function mapPgError(error: unknown): unknown {
  if (!isTransientPgError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  return agentError("unavailable", `conversation store temporarily unavailable: ${message}`);
}

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

export function memoryConversationStore(options: ConversationStoreOptions = {}): ConversationStore {
  const ttlMs = options.ephemeralTtlMs ?? DEFAULT_EPHEMERAL_TTL_MS;
  const maxEphemeral = options.maxEphemeral ?? DEFAULT_MAX_EPHEMERAL;
  const now = options.now ?? Date.now;
  const named = new Map<string, string>();
  const ephemeral = new Map<string, { sessionId: string; expiresAt: number }>();

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
    async get(key) {
      const durable = named.get(key);
      if (durable !== undefined) return durable;
      const entry = ephemeral.get(key);
      if (entry === undefined) return undefined;
      if (entry.expiresAt <= now()) {
        ephemeral.delete(key);
        return undefined;
      }
      return entry.sessionId;
    },
    async set(key, sessionId, setOptions) {
      if (setOptions?.ephemeral) {
        const current = now();
        ephemeral.delete(key);
        ephemeral.set(key, { sessionId, expiresAt: current + ttlMs });
        pruneEphemeral(current);
        return;
      }
      ephemeral.delete(key);
      named.set(key, sessionId);
    },
    async close() {},
  };
}

export function sqliteConversationStore(filePath: string, options: ConversationStoreOptions = {}): ConversationStore {
  const ttlMs = options.ephemeralTtlMs ?? DEFAULT_EPHEMERAL_TTL_MS;
  const now = options.now ?? Date.now;
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  db.exec(SQLITE_SCHEMA);
  const selectStmt = db.prepare("SELECT session_id, ephemeral, updated_at FROM fastagent_conversations WHERE name = ?");
  const upsertStmt = db.prepare(
    `INSERT INTO fastagent_conversations (name, session_id, ephemeral, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       session_id = excluded.session_id,
       ephemeral = excluded.ephemeral,
       updated_at = excluded.updated_at`,
  );
  const pruneStmt = db.prepare("DELETE FROM fastagent_conversations WHERE ephemeral = 1 AND updated_at <= ?");
  let closed = false;
  return {
    async get(key) {
      const row = selectStmt.get(key) as { session_id?: string; ephemeral?: number; updated_at?: number } | undefined;
      if (row?.session_id === undefined) return undefined;
      if (row.ephemeral === 1 && (row.updated_at ?? 0) <= now() - ttlMs) return undefined;
      return row.session_id;
    },
    async set(key, sessionId, setOptions) {
      const current = now();
      const isEphemeral = setOptions?.ephemeral === true ? 1 : 0;
      upsertStmt.run(key, sessionId, isEphemeral, current);
      if (isEphemeral === 1) pruneStmt.run(current - ttlMs);
    },
    async close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}

export function postgresConversationStore(
  database: PostgresDatabase,
  instance: string,
  options: ConversationStoreOptions = {},
): ConversationStore {
  const ttlMs = options.ephemeralTtlMs ?? DEFAULT_EPHEMERAL_TTL_MS;
  const now = options.now ?? Date.now;
  const { db, owned } = acquirePgDatabase(database);
  let migrated: Promise<void> | undefined;
  let lastPrunedAt = 0;
  let closed = false;

  const ensureSchema = (): Promise<void> => {
    migrated ??= db
      .query(PG_SCHEMA)
      .then(() => undefined)
      .catch((error: { code?: string }) => {
        if (PG_CONCURRENT_DDL.has(error.code ?? "")) return;
        migrated = undefined;
        throw mapPgError(error);
      });
    return migrated;
  };

  return {
    async get(key) {
      await ensureSchema();
      try {
        const rows = await db.query<{ session_id: string; ephemeral: boolean; updated_at: number }>(
          "SELECT session_id, ephemeral, updated_at FROM fastagent_conversations WHERE instance = $1 AND name = $2",
          [instance, key],
        );
        const row = rows[0];
        if (row === undefined) return undefined;
        if (row.ephemeral && Number(row.updated_at) <= now() - ttlMs) return undefined;
        return row.session_id;
      } catch (error) {
        throw mapPgError(error);
      }
    },
    async set(key, sessionId, setOptions) {
      await ensureSchema();
      const current = now();
      const isEphemeral = setOptions?.ephemeral === true;
      try {
        await db.query(
          `INSERT INTO fastagent_conversations (instance, name, session_id, ephemeral, updated_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (instance, name) DO UPDATE SET
             session_id = EXCLUDED.session_id,
             ephemeral = EXCLUDED.ephemeral,
             updated_at = EXCLUDED.updated_at`,
          [instance, key, sessionId, isEphemeral, current],
        );
        if (isEphemeral && current - lastPrunedAt >= PG_PRUNE_INTERVAL_MS) {
          lastPrunedAt = current;
          await db.query(
            "DELETE FROM fastagent_conversations WHERE instance = $1 AND ephemeral = TRUE AND updated_at <= $2",
            [instance, current - ttlMs],
          );
        }
      } catch (error) {
        throw mapPgError(error);
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      if (owned) await db.close();
    },
  };
}

const decodeInvokeRequest = Schema.decodeUnknownSync(InvokeRequest);

function validateInvokeRequest(raw: InvokeRequest): InvokeRequest {
  let request: InvokeRequest;
  try {
    request = decodeInvokeRequest(raw);
  } catch (error) {
    throw agentError("invalid_request", `invoke: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (request.conversation !== undefined && request.sessionId !== undefined) {
    throw agentError("invalid_request", "invoke: pass either conversation or sessionId, not both");
  }
  if (request.conversation !== undefined && request.conversation.trim() === "") {
    throw agentError("invalid_request", "invoke: conversation must not be blank");
  }
  return request;
}

function sendPayload(sessionId: string, request: InvokeRequest): SendRequest {
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
  const locks = new Map<string, Promise<unknown>>();
  const serialized = <T>(key: string, work: () => Promise<T>): Promise<T> => {
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
    key: string,
    title: string | undefined,
    settings: SessionSettings | undefined,
    ephemeral: boolean,
    signal: AbortSignal | undefined,
  ): Promise<string> => {
    checkSignal(signal);
    const created = await agent.sessions.create({
      ...(title === undefined ? {} : { title }),
      ...settings,
    });
    await store.set(key, created.id, { ephemeral });
    return created.id;
  };

  const resolveKeyed = (
    key: string,
    title: string | undefined,
    settings: SessionSettings | undefined,
    ephemeral: boolean,
    signal: AbortSignal | undefined,
  ): Promise<string> =>
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

  const resolveSessionId = async (request: InvokeRequest, signal: AbortSignal | undefined): Promise<string> => {
    checkSignal(signal);
    if (request.sessionId !== undefined) {
      if (request.session !== undefined) {
        await agent.sessions.update(request.sessionId, request.session);
      }
      return request.sessionId;
    }
    if (request.conversation !== undefined) {
      return resolveKeyed(`${prefix}c:${request.conversation}`, request.conversation, request.session, false, signal);
    }
    if (request.idempotencyKey !== undefined) {
      return resolveKeyed(`${prefix}i:${request.idempotencyKey}`, undefined, request.session, true, signal);
    }
    return (await agent.sessions.create(request.session)).id;
  };

  return {
    async invoke(raw: InvokeRequest, options?: WaitOptions): Promise<Message> {
      checkSignal(options?.signal);
      const request = validateInvokeRequest(raw);
      const sessionId = await resolveSessionId(request, options?.signal);
      checkSignal(options?.signal);
      return agent.messages.send(sendPayload(sessionId, request), options);
    },
    invokeStream(raw: InvokeRequest, options?: { signal?: AbortSignal }): AsyncIterable<MessageStreamEvent> {
      async function* stream(): AsyncGenerator<MessageStreamEvent> {
        checkSignal(options?.signal);
        const request = validateInvokeRequest(raw);
        const sessionId = await resolveSessionId(request, options?.signal);
        checkSignal(options?.signal);
        yield* agent.messages.stream(sendPayload(sessionId, request), options);
      }
      return stream();
    },
  };
}
