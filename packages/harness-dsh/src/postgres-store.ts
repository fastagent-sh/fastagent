/**
 * Durable PostgreSQL `DshEventStoreBackend` with multi-instance isolation and single-writer fencing
 * over `@fastagent-sh/fastagent/harness`.
 */
import { randomUUID } from "node:crypto";
import {
  acquirePgInstanceLease,
  isPgConflict,
  migratePgSchema,
  type PgDatabase,
  type PgExecutor,
  type PgLeaseHandoff,
  type SharedPostgresHandle,
} from "@fastagent-sh/fastagent/harness";
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

export interface PostgresDshStoreOptions {
  /** Optional shared connection pool handle enabling one-time migration and batched lease renewals. */
  readonly pool?: SharedPostgresHandle;
  /** Lease duration in milliseconds for single-writer instance ownership. Default: 30_000. */
  readonly leaseMs?: number;
  /** Maximum milliseconds to wait for an existing holder's lease to expire on open. Default: 0 (fail fast). */
  readonly waitMs?: number;
  /** Custom owner identifier for diagnostics. Default: random UUID. */
  readonly owner?: string;
  /** Human-readable description of other processes that may hold this instance. */
  readonly holders?: string;
  /** Optional cooperative idle handoff hooks (never invokes `onLost`). */
  readonly handoff?: PgLeaseHandoff;
  /** Invoked once if the single-writer lease is lost unexpectedly or fails renewal before expiry. */
  readonly onLost?: (error: Error) => void;
}

export interface PostgresDshEventStore extends DshEventStoreBackend {
  readonly instance: string;
  readonly owner: string;
  close(): Promise<void>;
}

const DSH_SCHEMA_VERSION = 1;
const DSH_LEASE_TABLE = "dsh_leases";
const DSH_SCHEMA_TABLE = "dsh_schema";

const MIGRATION_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS dsh_metadata (
    instance TEXT PRIMARY KEY,
    owner    TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS dsh_leases (
    instance             TEXT PRIMARY KEY,
    owner                TEXT,
    lease_until          TIMESTAMPTZ,
    handoff_requested_at TIMESTAMPTZ
  )`,
  `CREATE TABLE IF NOT EXISTS dsh_sessions (
    instance              TEXT NOT NULL,
    session_id            TEXT NOT NULL,
    header_json           TEXT NOT NULL,
    inherited_event_count INTEGER NOT NULL DEFAULT 0,
    meta_json             TEXT,
    PRIMARY KEY (instance, session_id)
  )`,
  `CREATE TABLE IF NOT EXISTS dsh_events (
    instance   TEXT NOT NULL,
    session_id TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    event_json TEXT NOT NULL,
    PRIMARY KEY (instance, session_id, seq)
  )`,
  `CREATE TABLE IF NOT EXISTS dsh_messages (
    instance        TEXT NOT NULL,
    session_id      TEXT NOT NULL,
    message_id      TEXT NOT NULL,
    idempotency_key TEXT,
    message_json    TEXT NOT NULL,
    PRIMARY KEY (instance, session_id, message_id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS dsh_messages_by_idempotency
    ON dsh_messages (instance, session_id, idempotency_key)`,
  `CREATE TABLE IF NOT EXISTS dsh_attachments (
    instance   TEXT NOT NULL,
    session_id TEXT NOT NULL,
    ref        TEXT NOT NULL,
    mime_type  TEXT NOT NULL,
    data_b64   TEXT NOT NULL,
    PRIMARY KEY (instance, session_id, ref)
  )`,
  `CREATE TABLE IF NOT EXISTS dsh_schema (
    version INTEGER PRIMARY KEY
  )`,
];

const clone = <T>(value: T): T => structuredClone(value);

async function migratePostgresDshSchema(db: PgExecutor): Promise<void> {
  await migratePgSchema(db, MIGRATION_STATEMENTS, {
    version: { table: DSH_SCHEMA_TABLE, current: DSH_SCHEMA_VERSION },
  });
}

export async function openPostgresDshStore(
  database: PgDatabase,
  instance: string,
  options: PostgresDshStoreOptions = {},
): Promise<PostgresDshEventStore> {
  if (!instance || instance.trim() === "") {
    throw new Error("DSH PostgreSQL store requires a non-empty instance name");
  }

  if (options.pool !== undefined) {
    await options.pool.ensureMigrated("dsh", (db) => migratePostgresDshSchema(db));
  } else {
    await migratePostgresDshSchema(database);
  }

  await database.query("INSERT INTO dsh_metadata (instance) VALUES ($1) ON CONFLICT (instance) DO NOTHING", [instance]);

  const lease = await acquirePgInstanceLease<void>(database, {
    table: DSH_LEASE_TABLE,
    instance,
    ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
    waitMs: options.waitMs ?? 0,
    owner: options.owner ?? randomUUID(),
    ...(options.holders === undefined ? {} : { holders: options.holders }),
    ...(options.pool === undefined ? {} : { pool: options.pool }),
    ...(options.handoff === undefined ? {} : { handoff: options.handoff }),
    ...(options.onLost === undefined ? {} : { onLost: options.onLost }),
    onTake: async (tx, owner) => {
      const [row] = await tx.query<{ instance: string }>(
        "UPDATE dsh_metadata SET owner = $2 WHERE instance = $1 RETURNING instance",
        [instance, owner],
      );
      if (row === undefined) {
        throw new Error(`the instance "${instance}" has no dsh_metadata row`);
      }
    },
  });

  let storeClosed = false;
  let closing: Promise<void> | undefined;
  let writeChain: Promise<unknown> = Promise.resolve();
  const writers = new Set<string>();

  const assertStoreOpen = (): void => {
    if (storeClosed) throw new Error(`DSH PostgreSQL store for "${instance}" is closed`);
    if (lease.lost !== undefined) throw lease.lost;
  };

  const runFencedWrite = <T>(work: (tx: PgExecutor) => Promise<T>): Promise<T> => {
    const run = async (): Promise<T> => {
      assertStoreOpen();
      try {
        return await database.transaction(async (tx) => {
          const [fenced] = await tx.query(
            "UPDATE dsh_metadata SET owner = $2 WHERE instance = $1 AND owner = $2 RETURNING instance",
            [instance, lease.owner],
          );
          if (fenced === undefined) throw lease.lose(undefined, true);
          return work(tx);
        });
      } catch (error) {
        if (isPgConflict(error)) throw lease.lose(undefined, true);
        throw error;
      }
    };
    const next = writeChain.then(run, run);
    writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const makeHandle = (
    id: string,
    access: "read" | "write",
    header: DshSessionHeader,
    inheritedEventCount: number,
  ): DshSessionHandle => {
    let closed = false;
    const assertOpen = () => {
      assertStoreOpen();
      if (closed) throw new Error(`DSH session handle for "${id}" is closed`);
    };

    const handle: DshSessionHandle = {
      id,
      access,
      header: clone(header),
      inheritedEventCount,
      get closed() {
        return closed || storeClosed;
      },
      async read(offset = 0, length?: number) {
        assertOpen();
        if (!Number.isInteger(offset) || offset < 0) {
          throw new Error(`DSH read offset must be a non-negative integer, got ${String(offset)}`);
        }
        if (length !== undefined && (!Number.isInteger(length) || length < 0)) {
          throw new Error(`DSH read length must be a non-negative integer, got ${String(length)}`);
        }
        const rows =
          length === undefined
            ? await database.query<{ event_json: string }>(
                "SELECT event_json FROM dsh_events WHERE instance = $1 AND session_id = $2 AND seq >= $3 ORDER BY seq ASC",
                [instance, id, offset],
              )
            : await database.query<{ event_json: string }>(
                "SELECT event_json FROM dsh_events WHERE instance = $1 AND session_id = $2 AND seq >= $3 ORDER BY seq ASC LIMIT $4",
                [instance, id, offset, length],
              );
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

        const firstSeq = events[0]?.seq as number;
        for (let i = 0; i < events.length; i++) {
          const expected = firstSeq + i;
          if (events[i]?.seq !== expected) {
            throw new Error(`DSH session "${id}" expected contiguous seq ${expected}, got ${String(events[i]?.seq)}`);
          }
        }

        const seqs = events.map((event) => event.seq);
        const payloads = events.map((event) => JSON.stringify(event));

        await runFencedWrite(async (tx) => {
          const countRows = await tx.query<{ count: string | number }>(
            "SELECT COUNT(*) AS count FROM dsh_events WHERE instance = $1 AND session_id = $2",
            [instance, id],
          );
          const expectedSeq = Number(countRows[0]?.count ?? 0);
          if (firstSeq !== expectedSeq) {
            throw new Error(`DSH session "${id}" expected contiguous seq ${expectedSeq}, got ${String(firstSeq)}`);
          }
          await tx.query(
            `INSERT INTO dsh_events (instance, session_id, seq, event_json)
             SELECT $1, $2, * FROM unnest($3::integer[], $4::text[])`,
            [instance, id, seqs, payloads],
          );
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
    instance,
    owner: lease.owner,

    async create(header, createOptions = {}) {
      assertStoreOpen();
      const inheritedEventCount = createOptions.inheritedEventCount ?? 0;
      if (header.isSeeded && inheritedEventCount <= 0) {
        throw new Error(`DSH seeded session "${header.id}" requires inheritedEventCount > 0`);
      }
      if (!header.isSeeded && inheritedEventCount !== 0) {
        throw new Error(`DSH unseeded session "${header.id}" must have inheritedEventCount = 0`);
      }
      if (writers.has(header.id)) {
        throw new Error(`DSH session "${header.id}" already exists`);
      }
      const headerJson = JSON.stringify(header);
      writers.add(header.id);
      try {
        await runFencedWrite(async (tx) => {
          const existing = await tx.query<{ session_id: string }>(
            "SELECT session_id FROM dsh_sessions WHERE instance = $1 AND session_id = $2",
            [instance, header.id],
          );
          if (existing.length > 0) {
            throw new Error(`DSH session "${header.id}" already exists`);
          }
          await tx.query(
            `INSERT INTO dsh_sessions (instance, session_id, header_json, inherited_event_count)
             VALUES ($1, $2, $3, $4)`,
            [instance, header.id, headerJson, inheritedEventCount],
          );
        });
      } catch (error) {
        writers.delete(header.id);
        throw error;
      }
      return makeHandle(header.id, "write", header, inheritedEventCount);
    },

    async open(id, access) {
      assertStoreOpen();
      if (access === "write") {
        if (writers.has(id)) {
          throw new Error(`DSH session "${id}" is already owned by another writer`);
        }
        writers.add(id);
      }
      try {
        const rows = await database.query<{ header_json: string; inherited_event_count: number }>(
          "SELECT header_json, inherited_event_count FROM dsh_sessions WHERE instance = $1 AND session_id = $2",
          [instance, id],
        );
        const row = rows[0];
        if (row === undefined) {
          throw new Error(`DSH session "${id}" does not exist`);
        }
        return makeHandle(
          id,
          access,
          JSON.parse(row.header_json) as DshSessionHeader,
          Number(row.inherited_event_count),
        );
      } catch (error) {
        if (access === "write") writers.delete(id);
        throw error;
      }
    },

    async flush() {
      assertStoreOpen();
      await writeChain;
    },

    async stat(id) {
      assertStoreOpen();
      const rows = await database.query<{
        header_json: string;
        event_count: string | number;
      }>(
        `SELECT s.header_json,
                (SELECT COUNT(*) FROM dsh_events e WHERE e.instance = s.instance AND e.session_id = s.session_id) AS event_count
         FROM dsh_sessions s
         WHERE s.instance = $1 AND s.session_id = $2`,
        [instance, id],
      );
      const row = rows[0];
      if (row === undefined) return undefined;
      const count = Number(row.event_count);
      return {
        header: JSON.parse(row.header_json) as DshSessionHeader,
        revision: String(count),
        eventCount: count,
      };
    },

    async list() {
      assertStoreOpen();
      const rows = await database.query<{
        header_json: string;
        event_count: string | number;
      }>(
        `SELECT s.header_json,
                (SELECT COUNT(*) FROM dsh_events e WHERE e.instance = s.instance AND e.session_id = s.session_id) AS event_count
         FROM dsh_sessions s
         WHERE s.instance = $1`,
        [instance],
      );
      return rows.map((row) => {
        const count = Number(row.event_count);
        return {
          header: JSON.parse(row.header_json) as DshSessionHeader,
          revision: String(count),
          eventCount: count,
        } satisfies DshSessionSnapshot;
      });
    },

    async getSessionMeta(id) {
      assertStoreOpen();
      const rows = await database.query<{ meta_json: string | null }>(
        "SELECT meta_json FROM dsh_sessions WHERE instance = $1 AND session_id = $2",
        [instance, id],
      );
      const row = rows[0];
      if (row === undefined || row.meta_json === null) return undefined;
      return JSON.parse(row.meta_json) as DshStoredSession;
    },

    async putSessionMeta(session) {
      assertStoreOpen();
      const metaJson = JSON.stringify(session);
      await runFencedWrite(async (tx) => {
        const updated = await tx.query<{ session_id: string }>(
          "UPDATE dsh_sessions SET meta_json = $3 WHERE instance = $1 AND session_id = $2 RETURNING session_id",
          [instance, session.id, metaJson],
        );
        if (updated.length === 0) {
          const fallbackHeader: DshSessionHeader = {
            version: 4,
            id: session.id,
            createdAt: session.createdAt,
            isSeeded: false,
          };
          await tx.query(
            `INSERT INTO dsh_sessions (instance, session_id, header_json, inherited_event_count, meta_json)
             VALUES ($1, $2, $3, 0, $4)`,
            [instance, session.id, JSON.stringify(fallbackHeader), metaJson],
          );
        }
      });
    },

    async listSessionMetas() {
      assertStoreOpen();
      const rows = await database.query<{ meta_json: string }>(
        "SELECT meta_json FROM dsh_sessions WHERE instance = $1 AND meta_json IS NOT NULL",
        [instance],
      );
      return rows.map((row) => JSON.parse(row.meta_json) as DshStoredSession);
    },

    async getMessage(sessionId, messageId) {
      assertStoreOpen();
      const rows = await database.query<{ message_json: string }>(
        "SELECT message_json FROM dsh_messages WHERE instance = $1 AND session_id = $2 AND message_id = $3",
        [instance, sessionId, messageId],
      );
      const row = rows[0];
      return row === undefined ? undefined : (JSON.parse(row.message_json) as DshStoredMessage);
    },

    async getMessageByKey(sessionId, idempotencyKey) {
      assertStoreOpen();
      const rows = await database.query<{ message_json: string }>(
        "SELECT message_json FROM dsh_messages WHERE instance = $1 AND session_id = $2 AND idempotency_key = $3",
        [instance, sessionId, idempotencyKey],
      );
      const row = rows[0];
      return row === undefined ? undefined : (JSON.parse(row.message_json) as DshStoredMessage);
    },

    async putMessage(message) {
      assertStoreOpen();
      const msgJson = JSON.stringify(message);
      await runFencedWrite(async (tx) => {
        await tx.query(
          `INSERT INTO dsh_messages (instance, session_id, message_id, idempotency_key, message_json)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (instance, session_id, message_id) DO UPDATE SET
             idempotency_key = EXCLUDED.idempotency_key,
             message_json = EXCLUDED.message_json`,
          [instance, message.sessionId, message.id, message.idempotencyKey ?? null, msgJson],
        );
      });
    },

    async listMessages(sessionId) {
      assertStoreOpen();
      const rows =
        sessionId !== undefined
          ? await database.query<{ message_json: string }>(
              "SELECT message_json FROM dsh_messages WHERE instance = $1 AND session_id = $2",
              [instance, sessionId],
            )
          : await database.query<{ message_json: string }>(
              "SELECT message_json FROM dsh_messages WHERE instance = $1",
              [instance],
            );
      return rows.map((row) => JSON.parse(row.message_json) as DshStoredMessage);
    },

    async putAttachment(attachment) {
      assertStoreOpen();
      const b64 = Buffer.from(attachment.data).toString("base64");
      await runFencedWrite(async (tx) => {
        await tx.query(
          `INSERT INTO dsh_attachments (instance, session_id, ref, mime_type, data_b64)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (instance, session_id, ref) DO UPDATE SET
             mime_type = EXCLUDED.mime_type,
             data_b64 = EXCLUDED.data_b64`,
          [instance, attachment.sessionId, attachment.ref, attachment.mimeType, b64],
        );
      });
    },

    async getAttachment(sessionId, ref) {
      assertStoreOpen();
      const rows = await database.query<{ mime_type: string; data_b64: string }>(
        "SELECT mime_type, data_b64 FROM dsh_attachments WHERE instance = $1 AND session_id = $2 AND ref = $3",
        [instance, sessionId, ref],
      );
      const row = rows[0];
      if (row === undefined) return undefined;
      return {
        ref,
        sessionId,
        mimeType: row.mime_type,
        data: new Uint8Array(Buffer.from(row.data_b64, "base64")),
      } satisfies DshStoredAttachment;
    },

    close() {
      storeClosed = true;
      closing ??= (async () => {
        writers.clear();
        await writeChain;
        await lease.release().catch(() => {});
      })();
      return closing;
    },
  };
}
