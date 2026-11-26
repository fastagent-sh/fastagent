/**
 * Durable PostgreSQL & Aurora DSQL `DshEventStoreBackend` with multi-instance isolation, single-writer fencing,
 * async index migration support, and `bytesPerValue` / per-transaction cap handling over `@fastagent-sh/fastagent/harness`.
 */
import { randomUUID } from "node:crypto";
import {
  acquirePgInstanceLease,
  isPgConflict,
  migratePgSchema,
  splitPgText,
  type CreateIndex,
  type PgDatabase,
  type PgExecutor,
  type PgLeaseHandoff,
  type PostgresLimits,
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
  /** Index builder for databases requiring async index creation (Aurora DSQL). */
  readonly createIndex?: CreateIndex;
  /** Transaction and per-value caps (e.g. `DSQL_LIMITS`). */
  readonly limits?: PostgresLimits;
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
    header_parts          INTEGER,
    inherited_event_count INTEGER NOT NULL DEFAULT 0,
    meta_json             TEXT,
    meta_parts            INTEGER,
    PRIMARY KEY (instance, session_id)
  )`,
  `CREATE TABLE IF NOT EXISTS dsh_events (
    instance    TEXT NOT NULL,
    session_id  TEXT NOT NULL,
    seq         INTEGER NOT NULL,
    event_json  TEXT NOT NULL,
    event_parts INTEGER,
    PRIMARY KEY (instance, session_id, seq)
  )`,
  `CREATE TABLE IF NOT EXISTS dsh_messages (
    instance        TEXT NOT NULL,
    session_id      TEXT NOT NULL,
    message_id      TEXT NOT NULL,
    idempotency_key TEXT,
    message_json    TEXT NOT NULL,
    message_parts   INTEGER,
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
    data_parts INTEGER,
    PRIMARY KEY (instance, session_id, ref)
  )`,
  `CREATE TABLE IF NOT EXISTS dsh_values (
    instance   TEXT NOT NULL,
    kind       TEXT NOT NULL,
    session_id TEXT NOT NULL,
    item_key   TEXT NOT NULL,
    part       INTEGER NOT NULL,
    body       TEXT NOT NULL,
    PRIMARY KEY (instance, kind, session_id, item_key, part)
  )`,
  `CREATE TABLE IF NOT EXISTS dsh_schema (
    version INTEGER PRIMARY KEY
  )`,
];

type DshValueKind = "header" | "meta" | "event" | "message" | "attachment";

interface PreparedValue {
  readonly inline: string;
  readonly parts: number | null;
  readonly chunks: readonly string[] | undefined;
  readonly rows: number;
  readonly bytes: number;
}

interface StoredValueRow {
  readonly sessionId: string;
  readonly itemKey: string;
  readonly body: string;
  readonly parts: number | null;
}

const clone = <T>(value: T): T => structuredClone(value);

function prepareValue(text: string, bytesPerValue: number | undefined): PreparedValue {
  const bytes = Buffer.byteLength(text, "utf8");
  const chunks = splitPgText(text, bytesPerValue);
  if (chunks === undefined) {
    return { inline: text, parts: null, chunks: undefined, rows: 1, bytes };
  }
  return { inline: "", parts: chunks.length, chunks, rows: 1 + chunks.length, bytes };
}

async function writeValueParts(
  tx: PgExecutor,
  instance: string,
  kind: DshValueKind,
  sessionId: string,
  itemKey: string,
  chunks: readonly string[] | undefined,
): Promise<void> {
  if (chunks === undefined) return;
  for (let part = 0; part < chunks.length; part++) {
    await tx.query(
      `INSERT INTO dsh_values (instance, kind, session_id, item_key, part, body)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (instance, kind, session_id, item_key, part) DO UPDATE SET body = EXCLUDED.body`,
      [instance, kind, sessionId, itemKey, part, chunks[part]],
    );
  }
}

async function readValues(
  executor: PgExecutor,
  instance: string,
  kind: DshValueKind,
  rows: readonly StoredValueRow[],
): Promise<string[]> {
  const parted = rows.filter((row) => row.parts !== null);
  if (parted.length === 0) return rows.map((row) => row.body);
  const found = await executor.query<{ session_id: string; item_key: string; part: number; body: string }>(
    `SELECT v.session_id, v.item_key, v.part, v.body
     FROM dsh_values AS v
     JOIN unnest($3::text[], $4::text[]) AS k(session_id, item_key)
       ON v.session_id = k.session_id AND v.item_key = k.item_key
     WHERE v.instance = $1 AND v.kind = $2
     ORDER BY v.session_id, v.item_key, v.part`,
    [instance, kind, parted.map((row) => row.sessionId), parted.map((row) => row.itemKey)],
  );
  const byKey = new Map<string, string[]>();
  for (const row of found) {
    const mapKey = `${row.session_id}\0${row.item_key}`;
    const list = byKey.get(mapKey) ?? [];
    list[row.part] = row.body;
    byKey.set(mapKey, list);
  }
  return rows.map((row) => {
    if (row.parts === null) return row.body;
    const parts = byKey.get(`${row.sessionId}\0${row.itemKey}`) ?? [];
    let whole = "";
    for (let i = 0; i < row.parts; i++) {
      const piece = parts[i];
      if (piece === undefined) {
        throw new Error(`DSH ${kind} "${row.sessionId}/${row.itemKey}" is missing part ${i} of its stored value`);
      }
      whole += piece;
    }
    return whole;
  });
}

function assertFitsTransaction(label: string, rows: number, bytes: number, limits: PostgresLimits | undefined): void {
  const maxRows = limits?.rowsPerTransaction;
  const maxBytes = limits?.bytesPerTransaction;
  if ((maxRows !== undefined && rows > maxRows) || (maxBytes !== undefined && bytes > maxBytes)) {
    throw new Error(
      `DSH ${label} (${rows} rows, ${bytes} bytes) exceeds the database transaction limit ` +
        `(${maxRows ?? "any"} rows, ${maxBytes ?? "any"} bytes)`,
    );
  }
}

/**
 * Open a durable PostgreSQL / Aurora DSQL `DshEventStoreBackend` scoped to `instance`.
 * Runs idempotent schema migration (including async index jobs when `createIndex` is provided) and acquires a
 * renewable single-writer lease in `dsh_leases`.
 * Does NOT close the caller-owned `database` pool on `close()`.
 * @public
 */
export async function openPostgresDshStore(
  database: Pick<PgDatabase, "query" | "transaction">,
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

  const limits = options.limits;
  const bytesPerValue = limits?.bytesPerValue;

  const runMigration = (db: PgExecutor) =>
    migratePgSchema(db, MIGRATION_STATEMENTS, {
      ...(options.createIndex === undefined ? {} : { createIndex: options.createIndex }),
      version: { table: DSH_SCHEMA_TABLE, current: DSH_SCHEMA_VERSION },
    });
  if (options.pool !== undefined) {
    await options.pool.ensureMigrated("dsh", runMigration);
  } else {
    await runMigration(database);
  }

  await database.query("INSERT INTO dsh_metadata (instance) VALUES ($1) ON CONFLICT (instance) DO NOTHING", [instance]);

  const lease = await acquirePgInstanceLease(database, {
    table: DSH_LEASE_TABLE,
    instance,
    owner,
    leaseMs,
    waitMs,
    ...(options.pool === undefined ? {} : { pool: options.pool }),
    ...(options.holders === undefined ? {} : { holders: options.holders }),
    ...(options.handoff === undefined ? {} : { handoff: options.handoff }),
    ...(options.onLost === undefined ? {} : { onLost: options.onLost }),
    onTake: async (tx, newOwner) => {
      await tx.query("UPDATE dsh_metadata SET owner = $2 WHERE instance = $1", [instance, newOwner]);
    },
    formatLostError: (name) => new Error(`PostgreSQL DSH lease for "${name}" was lost`),
  });

  let storeClosed = false;
  let closing: Promise<void> | undefined;
  const writers = new Set<string>();

  const assertStoreOpen = () => {
    if (storeClosed) throw new Error(`PostgreSQL DSH store for "${instance}" is closed`);
    if (lease.lost !== undefined) throw lease.lost;
  };

  // Serialize in-process writes for this instance and fence against `dsh_metadata` (separate from `dsh_leases`)
  // so background lease renewal and concurrent sessions in this process never trigger self-inflicted 40001/OC000.
  let writeChain: Promise<void> = Promise.resolve();
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

  // When `bytesPerValue` chunking is active, read parent rows and `dsh_values` in one REPEATABLE READ snapshot
  // so concurrent updates to mutable records (messages, session metadata) can never produce torn reads.
  const runConsistentRead = <T>(work: (exec: PgExecutor) => Promise<T>): Promise<T> =>
    bytesPerValue === undefined ? work(database) : database.transaction(work);

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
        const texts = await runConsistentRead(async (exec) => {
          const rows =
            length === undefined
              ? await exec.query<{ seq: number; event_json: string; event_parts: number | null }>(
                  "SELECT seq, event_json, event_parts FROM dsh_events WHERE instance = $1 AND session_id = $2 AND seq >= $3 ORDER BY seq ASC",
                  [instance, id, offset],
                )
              : await exec.query<{ seq: number; event_json: string; event_parts: number | null }>(
                  "SELECT seq, event_json, event_parts FROM dsh_events WHERE instance = $1 AND session_id = $2 AND seq >= $3 ORDER BY seq ASC LIMIT $4",
                  [instance, id, offset, length],
                );
          return readValues(
            exec,
            instance,
            "event",
            rows.map((row) => ({
              sessionId: id,
              itemKey: String(row.seq),
              body: row.event_json,
              parts: row.event_parts,
            })),
          );
        });
        return {
          events: texts.map((text) => JSON.parse(text) as DshSessionEvent),
          eventState: "detached" as const,
        };
      },
      async append(events) {
        assertOpen();
        if (access !== "write") {
          throw new Error(`DSH session handle for "${id}" is read-only`);
        }
        if (events.length === 0) return;

        // Validate intra-call contiguity before touching the database so partial multi-tx commits cannot occur on bad input.
        const firstSeq = events[0]?.seq as number;
        for (let i = 0; i < events.length; i++) {
          const expected = firstSeq + i;
          if (events[i]?.seq !== expected) {
            throw new Error(`DSH session "${id}" expected contiguous seq ${expected}, got ${String(events[i]?.seq)}`);
          }
        }

        const prepared = events.map((event) => ({
          seq: event.seq,
          value: prepareValue(JSON.stringify(event), bytesPerValue),
        }));

        // Partition into transaction-sized batches when `limits` are set (1 row reserved for the lease update).
        const maxRows = limits?.rowsPerTransaction;
        const maxBytes = limits?.bytesPerTransaction;
        const batches: (typeof prepared)[] = [];
        let currentBatch: typeof prepared = [];
        let batchRows = 1;
        let batchBytes = 0;
        for (const item of prepared) {
          assertFitsTransaction(`event seq ${item.seq}`, 1 + item.value.rows, item.value.bytes, limits);
          const exceeds =
            (maxRows !== undefined && batchRows + item.value.rows > maxRows) ||
            (maxBytes !== undefined && batchBytes + item.value.bytes > maxBytes);
          if (exceeds && currentBatch.length > 0) {
            batches.push(currentBatch);
            currentBatch = [];
            batchRows = 1;
            batchBytes = 0;
          }
          currentBatch.push(item);
          batchRows += item.value.rows;
          batchBytes += item.value.bytes;
        }
        if (currentBatch.length > 0) batches.push(currentBatch);

        for (const batch of batches) {
          await runFencedWrite(async (tx) => {
            const countRows = await tx.query<{ count: string | number }>(
              "SELECT COUNT(*) AS count FROM dsh_events WHERE instance = $1 AND session_id = $2",
              [instance, id],
            );
            const expectedSeq = Number(countRows[0]?.count ?? 0);
            const head = batch[0];
            if (head !== undefined && head.seq !== expectedSeq) {
              throw new Error(`DSH session "${id}" expected contiguous seq ${expectedSeq}, got ${String(head.seq)}`);
            }
            for (const item of batch) {
              await tx.query(
                "INSERT INTO dsh_events (instance, session_id, seq, event_json, event_parts) VALUES ($1, $2, $3, $4, $5)",
                [instance, id, item.seq, item.value.inline, item.value.parts],
              );
              await writeValueParts(tx, instance, "event", id, String(item.seq), item.value.chunks);
            }
          });
        }
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
      const headerVal = prepareValue(JSON.stringify(header), bytesPerValue);
      assertFitsTransaction(`session "${header.id}" header`, 1 + headerVal.rows, headerVal.bytes, limits);
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
            `INSERT INTO dsh_sessions (instance, session_id, header_json, header_parts, inherited_event_count)
             VALUES ($1, $2, $3, $4, $5)`,
            [instance, header.id, headerVal.inline, headerVal.parts, inheritedEventCount],
          );
          await writeValueParts(tx, instance, "header", header.id, "header", headerVal.chunks);
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
        const loaded = await runConsistentRead(async (exec) => {
          const rows = await exec.query<{
            header_json: string;
            header_parts: number | null;
            inherited_event_count: number;
          }>(
            "SELECT header_json, header_parts, inherited_event_count FROM dsh_sessions WHERE instance = $1 AND session_id = $2",
            [instance, id],
          );
          const row = rows[0];
          if (row === undefined) {
            throw new Error(`DSH session "${id}" does not exist`);
          }
          const [headerText] = await readValues(exec, instance, "header", [
            { sessionId: id, itemKey: "header", body: row.header_json, parts: row.header_parts },
          ]);
          return {
            header: JSON.parse(headerText as string) as DshSessionHeader,
            inheritedEventCount: Number(row.inherited_event_count),
          };
        });
        return makeHandle(id, access, loaded.header, loaded.inheritedEventCount);
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
      return runConsistentRead(async (exec) => {
        const rows = await exec.query<{
          header_json: string;
          header_parts: number | null;
          event_count: string | number;
        }>(
          `SELECT s.header_json, s.header_parts, COALESCE(e.cnt, 0) AS event_count
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
        const [headerText] = await readValues(exec, instance, "header", [
          { sessionId: id, itemKey: "header", body: row.header_json, parts: row.header_parts },
        ]);
        const count = Number(row.event_count);
        return {
          header: JSON.parse(headerText as string) as DshSessionHeader,
          revision: String(count),
          eventCount: count,
        };
      });
    },

    async list() {
      assertStoreOpen();
      return runConsistentRead(async (exec) => {
        const rows = await exec.query<{
          session_id: string;
          header_json: string;
          header_parts: number | null;
          event_count: string | number;
        }>(
          `SELECT s.session_id, s.header_json, s.header_parts, COALESCE(e.cnt, 0) AS event_count
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
        const headers = await readValues(
          exec,
          instance,
          "header",
          rows.map((row) => ({
            sessionId: row.session_id,
            itemKey: "header",
            body: row.header_json,
            parts: row.header_parts,
          })),
        );
        return rows.map((row, idx) => {
          const count = Number(row.event_count);
          return {
            header: JSON.parse(headers[idx] as string) as DshSessionHeader,
            revision: String(count),
            eventCount: count,
          } satisfies DshSessionSnapshot;
        });
      });
    },

    async getSessionMeta(id) {
      assertStoreOpen();
      return runConsistentRead(async (exec) => {
        const rows = await exec.query<{ meta_json: string | null; meta_parts: number | null }>(
          "SELECT meta_json, meta_parts FROM dsh_sessions WHERE instance = $1 AND session_id = $2",
          [instance, id],
        );
        const row = rows[0];
        if (row === undefined || row.meta_json === null) return undefined;
        const [metaText] = await readValues(exec, instance, "meta", [
          { sessionId: id, itemKey: "meta", body: row.meta_json, parts: row.meta_parts },
        ]);
        return JSON.parse(metaText as string) as DshStoredSession;
      });
    },

    async putSessionMeta(session) {
      assertStoreOpen();
      const metaVal = prepareValue(JSON.stringify(session), bytesPerValue);
      assertFitsTransaction(`session "${session.id}" metadata`, 1 + metaVal.rows, metaVal.bytes, limits);
      await runFencedWrite(async (tx) => {
        const updated = await tx.query<{ session_id: string }>(
          "UPDATE dsh_sessions SET meta_json = $3, meta_parts = $4 WHERE instance = $1 AND session_id = $2 RETURNING session_id",
          [instance, session.id, metaVal.inline, metaVal.parts],
        );
        if (updated.length === 0) {
          const fallbackHeader: DshSessionHeader = {
            version: 4,
            id: session.id,
            createdAt: session.createdAt,
            isSeeded: false,
          };
          const headerVal = prepareValue(JSON.stringify(fallbackHeader), bytesPerValue);
          assertFitsTransaction(
            `session "${session.id}" metadata`,
            1 + headerVal.rows + metaVal.rows,
            headerVal.bytes + metaVal.bytes,
            limits,
          );
          await tx.query(
            `INSERT INTO dsh_sessions (instance, session_id, header_json, header_parts, inherited_event_count, meta_json, meta_parts)
             VALUES ($1, $2, $3, $4, 0, $5, $6)`,
            [instance, session.id, headerVal.inline, headerVal.parts, metaVal.inline, metaVal.parts],
          );
          await writeValueParts(tx, instance, "header", session.id, "header", headerVal.chunks);
        }
        await writeValueParts(tx, instance, "meta", session.id, "meta", metaVal.chunks);
      });
    },

    async listSessionMetas() {
      assertStoreOpen();
      return runConsistentRead(async (exec) => {
        const rows = await exec.query<{ session_id: string; meta_json: string | null; meta_parts: number | null }>(
          "SELECT session_id, meta_json, meta_parts FROM dsh_sessions WHERE instance = $1 AND meta_json IS NOT NULL",
          [instance],
        );
        const present = rows.filter(
          (row): row is { session_id: string; meta_json: string; meta_parts: number | null } => row.meta_json !== null,
        );
        const texts = await readValues(
          exec,
          instance,
          "meta",
          present.map((row) => ({
            sessionId: row.session_id,
            itemKey: "meta",
            body: row.meta_json,
            parts: row.meta_parts,
          })),
        );
        return texts.map((text) => JSON.parse(text) as DshStoredSession);
      });
    },

    async getMessage(sessionId, messageId) {
      assertStoreOpen();
      return runConsistentRead(async (exec) => {
        const rows = await exec.query<{ message_json: string; message_parts: number | null }>(
          "SELECT message_json, message_parts FROM dsh_messages WHERE instance = $1 AND session_id = $2 AND message_id = $3",
          [instance, sessionId, messageId],
        );
        const row = rows[0];
        if (row === undefined) return undefined;
        const [text] = await readValues(exec, instance, "message", [
          { sessionId, itemKey: messageId, body: row.message_json, parts: row.message_parts },
        ]);
        return JSON.parse(text as string) as DshStoredMessage;
      });
    },

    async getMessageByKey(sessionId, idempotencyKey) {
      assertStoreOpen();
      return runConsistentRead(async (exec) => {
        const rows = await exec.query<{ message_id: string; message_json: string; message_parts: number | null }>(
          "SELECT message_id, message_json, message_parts FROM dsh_messages WHERE instance = $1 AND session_id = $2 AND idempotency_key = $3",
          [instance, sessionId, idempotencyKey],
        );
        const row = rows[0];
        if (row === undefined) return undefined;
        const [text] = await readValues(exec, instance, "message", [
          { sessionId, itemKey: row.message_id, body: row.message_json, parts: row.message_parts },
        ]);
        return JSON.parse(text as string) as DshStoredMessage;
      });
    },

    async putMessage(message) {
      assertStoreOpen();
      const msgVal = prepareValue(JSON.stringify(message), bytesPerValue);
      assertFitsTransaction(`message "${message.id}"`, 1 + msgVal.rows, msgVal.bytes, limits);
      await runFencedWrite(async (tx) => {
        await tx.query(
          `INSERT INTO dsh_messages (instance, session_id, message_id, idempotency_key, message_json, message_parts)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (instance, session_id, message_id) DO UPDATE SET
             idempotency_key = EXCLUDED.idempotency_key,
             message_json = EXCLUDED.message_json,
             message_parts = EXCLUDED.message_parts`,
          [instance, message.sessionId, message.id, message.idempotencyKey ?? null, msgVal.inline, msgVal.parts],
        );
        await writeValueParts(tx, instance, "message", message.sessionId, message.id, msgVal.chunks);
      });
    },

    async listMessages(sessionId) {
      assertStoreOpen();
      return runConsistentRead(async (exec) => {
        const rows =
          sessionId !== undefined
            ? await exec.query<{
                session_id: string;
                message_id: string;
                message_json: string;
                message_parts: number | null;
              }>(
                "SELECT session_id, message_id, message_json, message_parts FROM dsh_messages WHERE instance = $1 AND session_id = $2",
                [instance, sessionId],
              )
            : await exec.query<{
                session_id: string;
                message_id: string;
                message_json: string;
                message_parts: number | null;
              }>("SELECT session_id, message_id, message_json, message_parts FROM dsh_messages WHERE instance = $1", [
                instance,
              ]);
        const texts = await readValues(
          exec,
          instance,
          "message",
          rows.map((row) => ({
            sessionId: row.session_id,
            itemKey: row.message_id,
            body: row.message_json,
            parts: row.message_parts,
          })),
        );
        return texts.map((text) => JSON.parse(text) as DshStoredMessage);
      });
    },

    async putAttachment(attachment) {
      assertStoreOpen();
      const b64 = Buffer.from(attachment.data).toString("base64");
      const dataVal = prepareValue(b64, bytesPerValue);
      assertFitsTransaction(`attachment "${attachment.ref}"`, 1 + dataVal.rows, dataVal.bytes, limits);
      await runFencedWrite(async (tx) => {
        await tx.query(
          `INSERT INTO dsh_attachments (instance, session_id, ref, mime_type, data_b64, data_parts)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (instance, session_id, ref) DO UPDATE SET
             mime_type = EXCLUDED.mime_type,
             data_b64 = EXCLUDED.data_b64,
             data_parts = EXCLUDED.data_parts`,
          [instance, attachment.sessionId, attachment.ref, attachment.mimeType, dataVal.inline, dataVal.parts],
        );
        await writeValueParts(tx, instance, "attachment", attachment.sessionId, attachment.ref, dataVal.chunks);
      });
    },

    async getAttachment(sessionId, ref) {
      assertStoreOpen();
      return runConsistentRead(async (exec) => {
        const rows = await exec.query<{ mime_type: string; data_b64: string; data_parts: number | null }>(
          "SELECT mime_type, data_b64, data_parts FROM dsh_attachments WHERE instance = $1 AND session_id = $2 AND ref = $3",
          [instance, sessionId, ref],
        );
        const row = rows[0];
        if (row === undefined) return undefined;
        const [b64] = await readValues(exec, instance, "attachment", [
          { sessionId, itemKey: ref, body: row.data_b64, parts: row.data_parts },
        ]);
        return {
          ref,
          sessionId,
          mimeType: row.mime_type,
          data: new Uint8Array(Buffer.from(b64 as string, "base64")),
        } satisfies DshStoredAttachment;
      });
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
