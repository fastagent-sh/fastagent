/**
 * Harness-neutral caller-conversation mapping and single-call invoker (`POST /v1/invoke`, `agent.invoke`).
 * Keeps conversation-name and idempotency-key session bindings outside every harness (SQLite via `node:sqlite`,
 * shared PostgreSQL / Aurora DSQL, or in-memory), delegating execution purely through the standard `Agent` API.
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

export interface ConversationStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, sessionId: string): Promise<void>;
  close(): Promise<void>;
}

const PG_CONCURRENT_DDL = new Set(["42P07", "42710", "23505"]);

const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS fastagent_conversations (
  name       TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

const PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS fastagent_conversations (
  instance   TEXT NOT NULL,
  name       TEXT NOT NULL,
  session_id TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (instance, name)
);
`;

export function memoryConversationStore(): ConversationStore {
  const entries = new Map<string, string>();
  return {
    async get(key) {
      return entries.get(key);
    },
    async set(key, sessionId) {
      entries.set(key, sessionId);
    },
    async close() {},
  };
}

export function sqliteConversationStore(filePath: string): ConversationStore {
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  db.exec(SQLITE_SCHEMA);
  const selectStmt = db.prepare("SELECT session_id FROM fastagent_conversations WHERE name = ?");
  const upsertStmt = db.prepare(
    `INSERT INTO fastagent_conversations (name, session_id, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at`,
  );
  let closed = false;
  return {
    async get(key) {
      const row = selectStmt.get(key) as { session_id?: string } | undefined;
      return row?.session_id;
    },
    async set(key, sessionId) {
      upsertStmt.run(key, sessionId, Date.now());
    },
    async close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}

export function postgresConversationStore(database: PostgresDatabase, instance: string): ConversationStore {
  const { db, owned } = acquirePgDatabase(database);
  let migrated: Promise<void> | undefined;
  let closed = false;

  const ensureSchema = (): Promise<void> => {
    migrated ??= db
      .query(PG_SCHEMA)
      .then(() => undefined)
      .catch((error: { code?: string }) => {
        if (PG_CONCURRENT_DDL.has(error.code ?? "")) return;
        migrated = undefined;
        throw error;
      });
    return migrated;
  };

  return {
    async get(key) {
      await ensureSchema();
      const rows = await db.query<{ session_id: string }>(
        "SELECT session_id FROM fastagent_conversations WHERE instance = $1 AND name = $2",
        [instance, key],
      );
      return rows[0]?.session_id;
    },
    async set(key, sessionId) {
      await ensureSchema();
      await db.query(
        `INSERT INTO fastagent_conversations (instance, name, session_id, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (instance, name) DO UPDATE SET session_id = EXCLUDED.session_id, updated_at = EXCLUDED.updated_at`,
        [instance, key, sessionId, Date.now()],
      );
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

  const createAndRecord = async (
    key: string,
    title: string | undefined,
    settings: SessionSettings | undefined,
  ): Promise<string> => {
    const created = await agent.sessions.create({
      ...(title === undefined ? {} : { title }),
      ...settings,
    });
    await store.set(key, created.id);
    return created.id;
  };

  const resolveKeyed = (
    key: string,
    title: string | undefined,
    settings: SessionSettings | undefined,
  ): Promise<string> =>
    serialized(key, async () => {
      const existing = await store.get(key);
      if (existing !== undefined) {
        try {
          if (settings !== undefined) await agent.sessions.update(existing, settings);
          else await agent.sessions.get(existing);
          return existing;
        } catch (error) {
          if (!(error instanceof AgentError && error.code === "not_found")) throw error;
        }
      }
      return createAndRecord(key, title, settings);
    });

  const resolveSessionId = async (request: InvokeRequest): Promise<string> => {
    if (request.sessionId !== undefined) {
      if (request.session !== undefined) {
        await agent.sessions.update(request.sessionId, request.session);
      }
      return request.sessionId;
    }
    if (request.conversation !== undefined) {
      return resolveKeyed(`${prefix}c:${request.conversation}`, request.conversation, request.session);
    }
    if (request.idempotencyKey !== undefined) {
      return resolveKeyed(`${prefix}i:${request.idempotencyKey}`, undefined, request.session);
    }
    return (await agent.sessions.create(request.session)).id;
  };

  return {
    async invoke(raw: InvokeRequest, options?: WaitOptions): Promise<Message> {
      const request = validateInvokeRequest(raw);
      const sessionId = await resolveSessionId(request);
      return agent.messages.send(sendPayload(sessionId, request), options);
    },
    invokeStream(raw: InvokeRequest, options?: { signal?: AbortSignal }): AsyncIterable<MessageStreamEvent> {
      async function* stream(): AsyncGenerator<MessageStreamEvent> {
        const request = validateInvokeRequest(raw);
        const sessionId = await resolveSessionId(request);
        yield* agent.messages.stream(sendPayload(sessionId, request), options);
      }
      return stream();
    },
  };
}
