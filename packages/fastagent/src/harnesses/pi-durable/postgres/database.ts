/**
 * The PostgreSQL connection an instance's storage runs on: a node-postgres pool. A read is retried while the database
 * cannot be reached, as a restart or a failover of a managed database leaves it for a moment; a transaction is retried
 * only while it cannot get a connection, since a statement it sent may have taken effect.
 */
import pg from "pg";
import { parseIntoClientConfig } from "pg-connection-string";
import { log } from "../../../log.ts";

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
