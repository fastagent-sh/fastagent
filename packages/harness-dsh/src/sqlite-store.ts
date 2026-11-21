/**
 * Durable SQLite `DshEventStoreBackend` backed by Node's built-in `node:sqlite` (WAL mode).
 * Stores DSH session headers + append-only event logs alongside FastAgent's session metadata,
 * message ledger, and binary attachments in 4 tables with atomic contiguous-seq transactions.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  DshEventStoreBackend,
  DshSessionEvent,
  DshSessionHandle,
  DshSessionHeader,
  DshSessionSnapshot,
  DshStoredAttachment,
  DshStoredMessage,
  DshStoredSession,
} from "./types.ts";

export interface SqliteDshStoreOptions {
  /** Busy timeout in milliseconds when another process holds the SQLite lock. Default: 5000. */
  readonly busyTimeoutMs?: number;
}

export interface SqliteDshEventStore extends DshEventStoreBackend {
  readonly path: string;
  close(): Promise<void>;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS dsh_sessions (
  session_id            TEXT PRIMARY KEY,
  header_json           TEXT NOT NULL,
  inherited_event_count INTEGER NOT NULL DEFAULT 0,
  meta_json             TEXT
);

CREATE TABLE IF NOT EXISTS dsh_events (
  session_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE IF NOT EXISTS dsh_messages (
  session_id      TEXT NOT NULL,
  message_id      TEXT NOT NULL,
  idempotency_key TEXT,
  message_json    TEXT NOT NULL,
  PRIMARY KEY (session_id, message_id),
  UNIQUE (session_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS dsh_attachments (
  session_id TEXT NOT NULL,
  ref        TEXT NOT NULL,
  mime_type  TEXT NOT NULL,
  data       BLOB NOT NULL,
  PRIMARY KEY (session_id, ref)
);
`;

const clone = <T>(value: T): T => structuredClone(value);

/**
 * Open a durable SQLite `DshEventStoreBackend` at `filePath` (or `":memory:"`).
 * Uses WAL + `synchronous = FULL` so committed events and ledger updates survive `SIGKILL`.
 * @public
 */
export function openSqliteDshStore(filePath: string, options: SqliteDshStoreOptions = {}): SqliteDshEventStore {
  if (filePath !== ":memory:") {
    mkdirSync(dirname(filePath), { recursive: true });
  }
  const busyTimeoutMs = options.busyTimeoutMs ?? 5000;
  const db = new DatabaseSync(filePath, { timeout: busyTimeoutMs });
  if (filePath !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = FULL;");
  }
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(busyTimeoutMs))};`);
  db.exec(SCHEMA_SQL);

  const writers = new Set<string>();
  let dbClosed = false;

  const assertDbOpen = () => {
    if (dbClosed) throw new Error("SQLite DSH store is closed");
  };

  const runInTransaction = <T>(work: () => T): T => {
    assertDbOpen();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Ignore rollback failure when transaction already aborted.
      }
      throw error;
    }
  };

  const stmtInsertSession = db.prepare(
    "INSERT INTO dsh_sessions (session_id, header_json, inherited_event_count) VALUES (?, ?, ?)",
  );
  const stmtSelectSession = db.prepare(
    "SELECT session_id, header_json, inherited_event_count, meta_json FROM dsh_sessions WHERE session_id = ?",
  );
  const stmtSelectAllSessions = db.prepare(
    "SELECT session_id, header_json, inherited_event_count, meta_json FROM dsh_sessions",
  );
  const stmtUpdateSessionMeta = db.prepare("UPDATE dsh_sessions SET meta_json = ? WHERE session_id = ?");
  const stmtUpsertSessionMetaOnly = db.prepare(
    `INSERT INTO dsh_sessions (session_id, header_json, inherited_event_count, meta_json)
     VALUES (?, ?, 0, ?)
     ON CONFLICT(session_id) DO UPDATE SET meta_json = excluded.meta_json`,
  );
  const stmtCountEvents = db.prepare("SELECT COUNT(*) AS count FROM dsh_events WHERE session_id = ?");
  const stmtSelectEventsFrom = db.prepare(
    "SELECT event_json FROM dsh_events WHERE session_id = ? AND seq >= ? ORDER BY seq ASC",
  );
  const stmtSelectEventsSlice = db.prepare(
    "SELECT event_json FROM dsh_events WHERE session_id = ? AND seq >= ? ORDER BY seq ASC LIMIT ?",
  );
  const stmtInsertEvent = db.prepare("INSERT INTO dsh_events (session_id, seq, event_json) VALUES (?, ?, ?)");
  const stmtUpsertMessage = db.prepare(
    `INSERT INTO dsh_messages (session_id, message_id, idempotency_key, message_json)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id, message_id) DO UPDATE SET
       idempotency_key = excluded.idempotency_key,
       message_json = excluded.message_json`,
  );
  const stmtSelectMessage = db.prepare("SELECT message_json FROM dsh_messages WHERE session_id = ? AND message_id = ?");
  const stmtSelectMessageByKey = db.prepare(
    "SELECT message_json FROM dsh_messages WHERE session_id = ? AND idempotency_key = ?",
  );
  const stmtSelectSessionMessages = db.prepare("SELECT message_json FROM dsh_messages WHERE session_id = ?");
  const stmtSelectAllMessages = db.prepare("SELECT message_json FROM dsh_messages");
  const stmtUpsertAttachment = db.prepare(
    `INSERT INTO dsh_attachments (session_id, ref, mime_type, data)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id, ref) DO UPDATE SET
       mime_type = excluded.mime_type,
       data = excluded.data`,
  );
  const stmtSelectAttachment = db.prepare(
    "SELECT mime_type, data FROM dsh_attachments WHERE session_id = ? AND ref = ?",
  );

  const eventCountOf = (sessionId: string): number => {
    const row = stmtCountEvents.get(sessionId) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  };

  const makeHandle = (
    id: string,
    access: "read" | "write",
    header: DshSessionHeader,
    inheritedEventCount: number,
  ): DshSessionHandle => {
    let closed = false;
    const assertOpen = () => {
      assertDbOpen();
      if (closed) throw new Error(`DSH session handle for "${id}" is closed`);
    };

    const handle: DshSessionHandle = {
      id,
      access,
      header: clone(header),
      inheritedEventCount,
      get closed() {
        return closed || dbClosed;
      },
      async read(offset = 0, length?: number) {
        assertOpen();
        if (!Number.isInteger(offset) || offset < 0) {
          throw new Error(`DSH read offset must be a non-negative integer, got ${String(offset)}`);
        }
        if (length !== undefined && (!Number.isInteger(length) || length < 0)) {
          throw new Error(`DSH read length must be a non-negative integer, got ${String(length)}`);
        }
        const rows = (
          length === undefined ? stmtSelectEventsFrom.all(id, offset) : stmtSelectEventsSlice.all(id, offset, length)
        ) as Array<{ event_json: string }>;
        return {
          events: rows.map((row) => JSON.parse(row.event_json) as DshSessionEvent),
          eventState: "detached" as const,
        };
      },
      async append(events) {
        assertOpen();
        if (access !== "write") {
          throw new Error(`DSH session handle for "${id}" is read-only`);
        }
        if (events.length === 0) return;
        runInTransaction(() => {
          let expectedSeq = eventCountOf(id);
          for (const event of events) {
            if (event.seq !== expectedSeq) {
              throw new Error(`DSH session "${id}" expected contiguous seq ${expectedSeq}, got ${String(event.seq)}`);
            }
            expectedSeq += 1;
          }
          for (const event of events) {
            stmtInsertEvent.run(id, event.seq, JSON.stringify(event));
          }
        });
      },
      async flush() {
        assertOpen();
      },
      close: async () => {
        if (closed) return;
        closed = true;
        if (access === "write") writers.delete(id);
      },
      async [Symbol.asyncDispose]() {
        await handle.close();
      },
    };
    return handle;
  };

  return {
    path: filePath,

    async create(header, createOptions = {}) {
      assertDbOpen();
      const inheritedEventCount = createOptions.inheritedEventCount ?? 0;
      if (header.isSeeded && inheritedEventCount <= 0) {
        throw new Error(`DSH seeded session "${header.id}" requires inheritedEventCount > 0`);
      }
      if (!header.isSeeded && inheritedEventCount !== 0) {
        throw new Error(`DSH unseeded session "${header.id}" must have inheritedEventCount = 0`);
      }
      runInTransaction(() => {
        const existing = stmtSelectSession.get(header.id) as { session_id: string } | undefined;
        if (existing !== undefined) {
          throw new Error(`DSH session "${header.id}" already exists`);
        }
        stmtInsertSession.run(header.id, JSON.stringify(header), inheritedEventCount);
      });
      writers.add(header.id);
      return makeHandle(header.id, "write", header, inheritedEventCount);
    },

    async open(id, access) {
      assertDbOpen();
      const row = stmtSelectSession.get(id) as
        | { session_id: string; header_json: string; inherited_event_count: number }
        | undefined;
      if (row === undefined) {
        throw new Error(`DSH session "${id}" does not exist`);
      }
      if (access === "write") {
        if (writers.has(id)) {
          throw new Error(`DSH session "${id}" is already owned by another writer`);
        }
        writers.add(id);
      }
      return makeHandle(id, access, JSON.parse(row.header_json) as DshSessionHeader, Number(row.inherited_event_count));
    },

    async flush() {
      assertDbOpen();
    },

    async stat(id) {
      assertDbOpen();
      const row = stmtSelectSession.get(id) as { header_json: string } | undefined;
      if (row === undefined) return undefined;
      const count = eventCountOf(id);
      return {
        header: JSON.parse(row.header_json) as DshSessionHeader,
        revision: String(count),
        eventCount: count,
      };
    },

    async list() {
      assertDbOpen();
      const rows = stmtSelectAllSessions.all() as Array<{ session_id: string; header_json: string }>;
      return rows.map((row) => {
        const count = eventCountOf(row.session_id);
        return {
          header: JSON.parse(row.header_json) as DshSessionHeader,
          revision: String(count),
          eventCount: count,
        } satisfies DshSessionSnapshot;
      });
    },

    async getSessionMeta(id) {
      assertDbOpen();
      const row = stmtSelectSession.get(id) as { meta_json: string | null } | undefined;
      if (row?.meta_json === undefined || row.meta_json === null) return undefined;
      return JSON.parse(row.meta_json) as DshStoredSession;
    },

    async putSessionMeta(session) {
      assertDbOpen();
      const json = JSON.stringify(session);
      const updated = stmtUpdateSessionMeta.run(json, session.id);
      if (Number(updated.changes) === 0) {
        const fallbackHeader: DshSessionHeader = {
          version: 4,
          id: session.id,
          createdAt: session.createdAt,
          isSeeded: false,
        };
        stmtUpsertSessionMetaOnly.run(session.id, JSON.stringify(fallbackHeader), json);
      }
    },

    async listSessionMetas() {
      assertDbOpen();
      const rows = stmtSelectAllSessions.all() as Array<{ meta_json: string | null }>;
      return rows.flatMap((row) => (row.meta_json === null ? [] : [JSON.parse(row.meta_json) as DshStoredSession]));
    },

    async getMessage(sessionId, messageId) {
      assertDbOpen();
      const row = stmtSelectMessage.get(sessionId, messageId) as { message_json: string } | undefined;
      return row === undefined ? undefined : (JSON.parse(row.message_json) as DshStoredMessage);
    },

    async getMessageByKey(sessionId, idempotencyKey) {
      assertDbOpen();
      const row = stmtSelectMessageByKey.get(sessionId, idempotencyKey) as { message_json: string } | undefined;
      return row === undefined ? undefined : (JSON.parse(row.message_json) as DshStoredMessage);
    },

    async putMessage(message) {
      assertDbOpen();
      stmtUpsertMessage.run(message.sessionId, message.id, message.idempotencyKey ?? null, JSON.stringify(message));
    },

    async listMessages(sessionId) {
      assertDbOpen();
      const rows = (
        sessionId !== undefined ? stmtSelectSessionMessages.all(sessionId) : stmtSelectAllMessages.all()
      ) as Array<{ message_json: string }>;
      return rows.map((row) => JSON.parse(row.message_json) as DshStoredMessage);
    },

    async putAttachment(attachment) {
      assertDbOpen();
      stmtUpsertAttachment.run(
        attachment.sessionId,
        attachment.ref,
        attachment.mimeType,
        new Uint8Array(attachment.data),
      );
    },

    async getAttachment(sessionId, ref) {
      assertDbOpen();
      const row = stmtSelectAttachment.get(sessionId, ref) as { mime_type: string; data: Uint8Array } | undefined;
      if (row === undefined) return undefined;
      return {
        ref,
        sessionId,
        mimeType: row.mime_type,
        data: new Uint8Array(row.data),
      } satisfies DshStoredAttachment;
    },

    async close() {
      if (dbClosed) return;
      dbClosed = true;
      writers.clear();
      db.close();
    },
  };
}
