/**
 * Durable PostgreSQL `DshEventStoreBackend` with multi-instance isolation and `dsh_leases` single-writer fencing.
 * Accepts any structural `DshPgDatabase` (`query` + `transaction`) such as FastAgent's `openPgDatabase` /
 * `SharedPostgresDatabase`, keeping `@fastagent-sh/harness-dsh` free of a direct `pg` dependency.
 */
import { randomUUID } from "node:crypto";
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

/** Minimal query executor matching `PgExecutor` in `@fastagent-sh/fastagent/platform`. */
export interface DshPgExecutor {
  query<T extends object = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]>;
}

/** Minimal transactional database handle matching `PgDatabase`. */
export interface DshPgDatabase extends DshPgExecutor {
  transaction<T>(work: (tx: DshPgExecutor) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}

export interface PostgresDshStoreOptions {
  /** Lease duration in milliseconds for single-writer instance ownership. Default: 30_000. */
  readonly leaseMs?: number;
  /** Maximum milliseconds to wait for an existing holder's lease to expire on open. Default: 0 (fail fast). */
  readonly waitMs?: number;
  /** Custom owner identifier for diagnostics. Default: random UUID. */
  readonly owner?: string;
}

export interface PostgresDshEventStore extends DshEventStoreBackend {
  readonly instance: string;
  readonly owner: string;
  close(): Promise<void>;
}

/** Raised when another active process already holds the lease for the same DSH instance. */
export class DshInstanceHeldError extends Error {
  readonly instance: string;
  readonly holder: string;

  constructor(instance: string, holder: string) {
    super(`DSH instance "${instance}" is already held by another process (${holder})`);
    this.name = "DshInstanceHeldError";
    this.instance = instance;
    this.holder = holder;
  }
}

const MIGRATION_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS dsh_leases (
    instance    TEXT PRIMARY KEY,
    owner       TEXT NOT NULL,
    lease_until BIGINT NOT NULL
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
    PRIMARY KEY (instance, session_id, message_id),
    UNIQUE (instance, session_id, idempotency_key)
  )`,
  `CREATE TABLE IF NOT EXISTS dsh_attachments (
    instance   TEXT NOT NULL,
    session_id TEXT NOT NULL,
    ref        TEXT NOT NULL,
    mime_type  TEXT NOT NULL,
    data_b64   TEXT NOT NULL,
    PRIMARY KEY (instance, session_id, ref)
  )`,
];

const clone = <T>(value: T): T => structuredClone(value);

async function migrateDshSchema(db: DshPgDatabase): Promise<void> {
  for (const sql of MIGRATION_STATEMENTS) {
    await db.query(sql);
  }
}

const PG_NOW_MS_SQL = "FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT";

async function tryAcquireLease(
  db: DshPgDatabase,
  instance: string,
  owner: string,
  leaseMs: number,
): Promise<{ acquired: true } | { acquired: false; holder: string }> {
  const rows = await db.query<{ owner: string }>(
    `INSERT INTO dsh_leases (instance, owner, lease_until)
     VALUES ($1, $2, (${PG_NOW_MS_SQL}) + $3)
     ON CONFLICT (instance) DO UPDATE
       SET owner = EXCLUDED.owner, lease_until = (${PG_NOW_MS_SQL}) + $3
       WHERE dsh_leases.owner = $2 OR dsh_leases.lease_until <= (${PG_NOW_MS_SQL})
     RETURNING owner`,
    [instance, owner, leaseMs],
  );
  if (rows.length > 0 && rows[0]?.owner === owner) {
    return { acquired: true };
  }
  const current = await db.query<{ owner: string }>("SELECT owner FROM dsh_leases WHERE instance = $1", [instance]);
  return { acquired: false, holder: current[0]?.owner ?? "unknown" };
}

/**
 * Open a durable PostgreSQL `DshEventStoreBackend` scoped to `instance`.
 * Runs idempotent schema migration and acquires a renewable single-writer lease in `dsh_leases`.
 * Does NOT close the caller-owned `database` pool on `close()`.
 * @public
 */
export async function openPostgresDshStore(
  database: DshPgDatabase,
  instance: string,
  options: PostgresDshStoreOptions = {},
): Promise<PostgresDshEventStore> {
  if (!instance || instance.trim() === "") {
    throw new Error("DSH PostgreSQL instance name must be non-empty");
  }
  const leaseMs = options.leaseMs ?? 30_000;
  const waitMs = options.waitMs ?? 0;
  const owner = options.owner ?? randomUUID();
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
    throw new Error(`DSH PostgreSQL leaseMs must be positive, got ${String(leaseMs)}`);
  }
  if (!Number.isFinite(waitMs) || waitMs < 0) {
    throw new Error(`DSH PostgreSQL waitMs must be non-negative, got ${String(waitMs)}`);
  }

  await migrateDshSchema(database);

  const deadline = Date.now() + waitMs;
  for (;;) {
    const attempt = await tryAcquireLease(database, instance, owner, leaseMs);
    if (attempt.acquired) break;
    if (Date.now() >= deadline) {
      throw new DshInstanceHeldError(instance, attempt.holder);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(5, deadline - Date.now()))));
  }

  let storeClosed = false;
  let leaseLost = false;
  const writers = new Set<string>();

  const assertStoreOpen = () => {
    if (storeClosed) throw new Error(`PostgreSQL DSH store for "${instance}" is closed`);
    if (leaseLost) throw new Error(`PostgreSQL DSH lease for "${instance}" was lost`);
  };

  const assertLeaseInTx = async (tx: DshPgExecutor): Promise<void> => {
    const rows = await tx.query<{ owner: string }>(
      `UPDATE dsh_leases
       SET lease_until = (${PG_NOW_MS_SQL}) + $3
       WHERE instance = $1 AND owner = $2 AND lease_until > (${PG_NOW_MS_SQL})
       RETURNING owner`,
      [instance, owner, leaseMs],
    );
    if (rows.length === 0) {
      leaseLost = true;
      throw new Error(`PostgreSQL DSH lease for "${instance}" was lost`);
    }
  };

  const renewIntervalMs = Math.max(100, Math.floor(leaseMs / 3));
  const renewTimer = setInterval(() => {
    if (storeClosed) return;
    void database
      .query<{ owner: string }>(
        `UPDATE dsh_leases
         SET lease_until = (${PG_NOW_MS_SQL}) + $3
         WHERE instance = $1 AND owner = $2 AND lease_until > (${PG_NOW_MS_SQL})
         RETURNING owner`,
        [instance, owner, leaseMs],
      )
      .then((rows) => {
        if (rows.length === 0) leaseLost = true;
      })
      .catch(() => {
        // Transient DB hiccup; next renewal tick will retry or lease will expire.
      });
  }, renewIntervalMs);
  renewTimer.unref?.();

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
        await database.transaction(async (tx) => {
          await assertLeaseInTx(tx);
          const countRows = await tx.query<{ count: string | number }>(
            "SELECT COUNT(*) AS count FROM dsh_events WHERE instance = $1 AND session_id = $2",
            [instance, id],
          );
          let expectedSeq = Number(countRows[0]?.count ?? 0);
          for (const event of events) {
            if (event.seq !== expectedSeq) {
              throw new Error(`DSH session "${id}" expected contiguous seq ${expectedSeq}, got ${String(event.seq)}`);
            }
            expectedSeq += 1;
          }
          for (const event of events) {
            await tx.query("INSERT INTO dsh_events (instance, session_id, seq, event_json) VALUES ($1, $2, $3, $4)", [
              instance,
              id,
              event.seq,
              JSON.stringify(event),
            ]);
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
    instance,
    owner,

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
      writers.add(header.id);
      try {
        await database.transaction(async (tx) => {
          await assertLeaseInTx(tx);
          const existing = await tx.query<{ session_id: string }>(
            "SELECT session_id FROM dsh_sessions WHERE instance = $1 AND session_id = $2",
            [instance, header.id],
          );
          if (existing.length > 0) {
            throw new Error(`DSH session "${header.id}" already exists`);
          }
          await tx.query(
            "INSERT INTO dsh_sessions (instance, session_id, header_json, inherited_event_count) VALUES ($1, $2, $3, $4)",
            [instance, header.id, JSON.stringify(header), inheritedEventCount],
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
    },

    async stat(id) {
      assertStoreOpen();
      const rows = await database.query<{ header_json: string; event_count: string | number }>(
        `SELECT s.header_json, COALESCE(e.cnt, 0) AS event_count
         FROM dsh_sessions s
         LEFT JOIN (
           SELECT session_id, COUNT(*) AS cnt
           FROM dsh_events
           WHERE instance = $1 AND session_id = $2
           GROUP BY session_id
         ) e ON e.session_id = s.session_id
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
      const rows = await database.query<{ header_json: string; event_count: string | number }>(
        `SELECT s.header_json, COALESCE(e.cnt, 0) AS event_count
         FROM dsh_sessions s
         LEFT JOIN (
           SELECT session_id, COUNT(*) AS cnt
           FROM dsh_events
           WHERE instance = $1
           GROUP BY session_id
         ) e ON e.session_id = s.session_id
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
      const json = rows[0]?.meta_json;
      return json === undefined || json === null ? undefined : (JSON.parse(json) as DshStoredSession);
    },

    async putSessionMeta(session) {
      assertStoreOpen();
      const json = JSON.stringify(session);
      const fallbackHeader: DshSessionHeader = {
        version: 4,
        id: session.id,
        createdAt: session.createdAt,
        isSeeded: false,
      };
      await database.transaction(async (tx) => {
        await assertLeaseInTx(tx);
        await tx.query(
          `INSERT INTO dsh_sessions (instance, session_id, header_json, inherited_event_count, meta_json)
           VALUES ($1, $2, $3, 0, $4)
           ON CONFLICT (instance, session_id) DO UPDATE SET meta_json = EXCLUDED.meta_json`,
          [instance, session.id, JSON.stringify(fallbackHeader), json],
        );
      });
    },

    async listSessionMetas() {
      assertStoreOpen();
      const rows = await database.query<{ meta_json: string | null }>(
        "SELECT meta_json FROM dsh_sessions WHERE instance = $1 AND meta_json IS NOT NULL",
        [instance],
      );
      return rows.flatMap((row) => (row.meta_json === null ? [] : [JSON.parse(row.meta_json) as DshStoredSession]));
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
      await database.transaction(async (tx) => {
        await assertLeaseInTx(tx);
        await tx.query(
          `INSERT INTO dsh_messages (instance, session_id, message_id, idempotency_key, message_json)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (instance, session_id, message_id) DO UPDATE SET
             idempotency_key = EXCLUDED.idempotency_key,
             message_json = EXCLUDED.message_json`,
          [instance, message.sessionId, message.id, message.idempotencyKey ?? null, JSON.stringify(message)],
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
      await database.transaction(async (tx) => {
        await assertLeaseInTx(tx);
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

    async close() {
      if (storeClosed) return;
      storeClosed = true;
      clearInterval(renewTimer);
      writers.clear();
      await database
        .query("DELETE FROM dsh_leases WHERE instance = $1 AND owner = $2", [instance, owner])
        .catch(() => {});
    },
  };
}
