/**
 * The PostgreSQL connection an instance's storage runs on: a node-postgres pool. A read is retried while the database
 * cannot be reached, as a restart or a failover of a managed database leaves it for a moment; a transaction is retried
 * only while it cannot get a connection, since a statement it sent may have taken effect.
 */
import pg from "pg";
import { parseIntoClientConfig } from "pg-connection-string";
import { log } from "./log.ts";

export interface PgExecutor {
  query<T extends object = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]>;
}

export interface PgDatabase extends PgExecutor {
  /** `work` in one transaction at REPEATABLE READ: one snapshot for its reads, committed when it resolves. */
  transaction<T>(work: (tx: PgExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const INT8 = 20;
const CONNECT_TIMEOUT_MS = 10_000;
const ATTEMPTS = 4;

const PASSING_SOCKET = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "EPIPE",
]);
const PASSING_SQLSTATE = /^(08|53|57P0[1-3]$|40001$|40P01$|OC00[01]$)/;

/** Whether `error` (or its `cause` chain) is a transient PostgreSQL / Aurora DSQL failure safe to treat as unavailable. */
export function isTransientPgError(error: unknown): boolean {
  for (let at: unknown = error; at instanceof Error; at = at.cause) {
    const code = (at as { code?: unknown }).code;
    if (typeof code === "string" && (PASSING_SOCKET.has(code) || PASSING_SQLSTATE.test(code))) return true;
    if (/Connection terminated|timeout exceeded when trying to connect/.test(at.message)) return true;
  }
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && (PASSING_SOCKET.has(code) || PASSING_SQLSTATE.test(code));
}

/** An error that means the database was not reached: nothing the attempt sent took effect, or nothing was sent. */
function unreachable(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") {
    if (["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE"].includes(code)) return true;
    // connection_exception, admin_shutdown, crash_shutdown, cannot_connect_now
    if (code.startsWith("08") || code === "57P01" || code === "57P02" || code === "57P03") return true;
  }
  return error instanceof Error && /Connection terminated|timeout exceeded when trying to connect/.test(error.message);
}

async function retrying<T>(attempt: () => Promise<T>): Promise<T> {
  for (let tries = 1; ; tries++) {
    try {
      return await attempt();
    } catch (error) {
      if (tries >= ATTEMPTS || !unreachable(error)) throw error;
      log.warn(`[fastagent] the database is unreachable (${String(error)}); retrying`);
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (tries - 1)));
    }
  }
}

export interface PostgresPoolOptions {
  /** Maximum number of clients in the underlying PostgreSQL pool (node-postgres default: 10). */
  max?: number;
  /** Milliseconds an idle client stays open before being closed (node-postgres default: 10,000). */
  idleTimeoutMillis?: number;
}

/**
 * A pool on `connectionString` (`postgres://user:password@host:port/database?sslmode=require`); `password`, when given,
 * makes the password of each new connection (a token that expires).
 */
export function openPgDatabase(
  connectionString: string,
  options: PostgresPoolOptions & { password?: () => Promise<string> } = {},
): PgDatabase {
  if (options.max !== undefined && (!Number.isInteger(options.max) || options.max <= 0)) {
    throw new Error(`Postgres pool max must be a positive integer, got ${String(options.max)}`);
  }
  if (
    options.idleTimeoutMillis !== undefined &&
    (!Number.isFinite(options.idleTimeoutMillis) || options.idleTimeoutMillis < 0)
  ) {
    throw new Error(
      `Postgres pool idleTimeoutMillis must be a non-negative number, got ${String(options.idleTimeoutMillis)}`,
    );
  }
  // A connection string's own password, even an empty one, would win over `password`: parsed here, it gives way.
  const connection =
    options.password === undefined
      ? { connectionString }
      : { ...(parseIntoClientConfig(connectionString) as pg.PoolConfig), password: options.password };
  const pool = new pg.Pool({
    ...connection,
    ...(options.max === undefined ? {} : { max: options.max }),
    ...(options.idleTimeoutMillis === undefined ? {} : { idleTimeoutMillis: options.idleTimeoutMillis }),
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    // Ids and seqs are below 2^53: as numbers, as pi-durable keeps them.
    types: {
      getTypeParser: ((oid: number, format?: "text" | "binary") =>
        oid === INT8
          ? (value: string) => Number(value)
          : pg.types.getTypeParser(oid, format)) as typeof pg.types.getTypeParser,
    },
  });
  // An idle connection the server dropped: the pool replaces it, and the next query gets a new one.
  pool.on("error", (error) => log.warn(`[fastagent] a database connection failed: ${String(error)}`));
  return {
    query: (text, params) => retrying(async () => (await pool.query(text, params as unknown[])).rows),
    async transaction(work) {
      const client = await retrying(() => pool.connect());
      // A connection whose rollback failed is broken: the pool discards it instead of handing it out again.
      let broken: Error | undefined;
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
        const result = await work({
          query: async (text, params) => (await client.query(text, params as unknown[])).rows,
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch((rollback: Error) => {
          broken = rollback;
        });
        throw error;
      } finally {
        client.release(broken);
      }
    },
    close: () => pool.end(),
  };
}

/** Where `connectionString` points, without its credentials: what a log line or a refusal may say. */
export function describeDatabase(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return "(an unparsable database URL)";
  }
}

/**
 * How an index is made: by default its statement as written. A database that builds one as a job (Aurora DSQL's
 * `ASYNC`) starts it and answers how to wait for it.
 */
export type CreateIndex = (db: PgExecutor, statement: string) => Promise<(() => Promise<void>) | void>;

/**
 * Per-transaction caps a managed PostgreSQL database imposes (such as Aurora DSQL's 3,000 rows and 10 MiB per
 * transaction). Unset means no cap.
 */
export interface PostgresLimits {
  rowsPerTransaction?: number;
  bytesPerTransaction?: number;
  bytesPerValue?: number;
}

/**
 * The longest message an agent takes into a storage of `limits`: a message is written once, in one batch, and four
 * fifths of a transaction leave the rest of its batch room. Unset with no transaction cap.
 */
export function messageBytesFor(limits: PostgresLimits | undefined): number | undefined {
  const bytes = limits?.bytesPerTransaction;
  return bytes === undefined ? undefined : Math.floor(bytes * 0.8);
}

/** How the database is reached and what it allows, past its URL: what a platform's own database needs. */
export interface PostgresOptions {
  /** The password of each new connection, when the URL has none that lasts (a signed token). */
  password?: () => Promise<string>;
  limits?: PostgresLimits;
  createIndex?: CreateIndex;
}

/** A PostgreSQL database an instance's storage is in: its URL (`postgres://…`), and how it is reached. */
export interface PostgresDatabase extends PostgresOptions {
  url: string;
}

const SHARED_DB = Symbol("fastagent.sharedPostgres");

export interface SharedPostgresHandle {
  readonly borrowed: PgDatabase;
  isClosed(): boolean;
  assertOpen(): void;
  ensureMigrated(key: string, run: (db: PgDatabase) => Promise<void>): Promise<void>;
  /** Register a cleanup listener invoked once when the shared pool begins closing. */
  onClose(listener: () => void): () => void;
}

/**
 * A shared PostgreSQL connection pool handle reusable across multiple `openAgent` instances in one process:
 * schema migration runs once (single-flight), and each `agent.close()` releases only that instance's lease without
 * closing the underlying pool. Call `close()` once on host shutdown.
 */
export interface SharedPostgresDatabase extends PostgresDatabase {
  close(): Promise<void>;
}

type SharedPostgresInternal = SharedPostgresDatabase & { readonly [SHARED_DB]: SharedPostgresHandle };

export function sharedHandleOf(database: PostgresDatabase): SharedPostgresHandle | undefined {
  return (database as Partial<SharedPostgresInternal>)[SHARED_DB];
}

export function isSharedPostgresDatabase(database: PostgresDatabase): database is SharedPostgresDatabase {
  return sharedHandleOf(database) !== undefined;
}

/** Borrow a shared `PgDatabase` pool or open a dedicated one for a caller-managed harness store. */
export function acquirePgDatabase(database: PostgresDatabase): { readonly db: PgDatabase; readonly owned: boolean } {
  const shared = sharedHandleOf(database);
  if (shared !== undefined) {
    shared.assertOpen();
    return { db: shared.borrowed, owned: false };
  }
  const db = openPgDatabase(database.url, database.password === undefined ? {} : { password: database.password });
  return { db, owned: true };
}

/**
 * Open a shared PostgreSQL connection pool for reuse across multiple `openAgent` instances in one process.
 * Accepts any {@link PostgresDatabase}, including `{ url }` or `dsqlDatabase({ endpoint })`.
 */
export function openPostgresDatabase(
  database: PostgresDatabase,
  options: PostgresPoolOptions = {},
): SharedPostgresDatabase {
  const { url, password, limits, createIndex } = database;
  const db = openPgDatabase(url, {
    ...options,
    ...(password === undefined ? {} : { password }),
  });
  let closed = false;
  let closing: Promise<void> | undefined;
  const migrations = new Map<string, Promise<void>>();
  const closeListeners = new Set<() => void>();

  const assertOpen = () => {
    if (closed) throw new Error(`the shared database ${describeDatabase(url)} is closed`);
  };
  const borrowed: PgDatabase = {
    query: (text, params) => db.query(text, params),
    transaction: (work) => db.transaction(work),
    close: async () => {},
  };
  const handle: SharedPostgresHandle = {
    borrowed,
    isClosed: () => closed,
    assertOpen,
    ensureMigrated(key, run) {
      assertOpen();
      let pending = migrations.get(key);
      if (pending === undefined) {
        pending = run(db).catch((error) => {
          migrations.delete(key);
          throw error;
        });
        migrations.set(key, pending);
      }
      return pending;
    },
    onClose(listener) {
      if (closed) {
        listener();
        return () => {};
      }
      closeListeners.add(listener);
      return () => {
        closeListeners.delete(listener);
      };
    },
  };

  const shared: SharedPostgresInternal = {
    [SHARED_DB]: handle,
    url,
    ...(password === undefined ? {} : { password }),
    ...(limits === undefined ? {} : { limits }),
    ...(createIndex === undefined ? {} : { createIndex }),
    close() {
      if (!closed) {
        closed = true;
        for (const listener of [...closeListeners]) {
          closeListeners.delete(listener);
          listener();
        }
      }
      closing ??= db.close();
      return closing;
    },
  };
  return shared;
}
