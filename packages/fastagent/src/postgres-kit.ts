/**
 * Harness-neutral PostgreSQL and Aurora DSQL storage primitives shared across `pi-durable`, `@fastagent-sh/harness-dsh`,
 * and future harnesses: idempotent DDL + async index migration, OCC conflict detection, UTF-8 value chunking for
 * `bytesPerValue` caps, and single-writer instance leasing.
 */
import { log } from "./log.ts";
import type { CreateIndex, PgDatabase, PgExecutor } from "./postgres.ts";
import { Unavailable } from "./unavailable.ts";

/**
 * PostgreSQL SQLSTATE codes raised when two processes race on `CREATE ... IF NOT EXISTS`:
 * duplicate_table (`42P07`), duplicate_object (`42710`), or unique_violation on pg_catalog (`23505`).
 */
export const PG_CONCURRENT_DDL = new Set(["42P07", "42710", "23505"]);

/** OCC conflicts: PostgreSQL's serialization failure (`40001`) and Aurora DSQL's (`OC000`). */
const PG_CONFLICT_CODES = new Set(["40001", "OC000"]);

/** Whether `error` is an OCC serialization conflict (`40001` or Aurora DSQL `OC000`). */
export function isPgConflict(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && PG_CONFLICT_CODES.has(code);
}

const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const INDEX_STATEMENT = /^CREATE (?:UNIQUE )?INDEX /;

const createIndexAsWritten: CreateIndex = async (db, statement) => {
  await db.query(statement);
};

export interface MigratePgSchemaOptions {
  /** Index builder: defaults to executing the statement directly; Aurora DSQL runs `CREATE [UNIQUE] INDEX ASYNC`. */
  readonly createIndex?: CreateIndex;
  /** Optional schema version table checked before DDL and recorded once all tables and indexes are ready. */
  readonly version?: {
    readonly table: string;
    readonly current: number;
  };
}

/**
 * Apply idempotent table and index DDL statements to PostgreSQL or Aurora DSQL:
 * - Each statement runs in its own transaction (required by databases that allow one DDL statement per transaction).
 * - Concurrent `CREATE ... IF NOT EXISTS` races are ignored safely.
 * - `CREATE [UNIQUE] INDEX` statements run sequentially via `createIndex` (DSQL rejects concurrent schema jobs with
 *   `OC001`) and any async wait handles are awaited concurrently so first-time cluster migration stays fast.
 */
export async function migratePgSchema(
  db: PgExecutor,
  statements: readonly string[],
  options: MigratePgSchemaOptions = {},
): Promise<void> {
  const { createIndex = createIndexAsWritten, version } = options;
  if (version !== undefined) {
    if (!SAFE_IDENTIFIER.test(version.table)) {
      throw new Error(`Invalid PostgreSQL schema version table name: ${JSON.stringify(version.table)}`);
    }
    const existing = await db
      .query<{ version: number }>(`SELECT max(version) AS version FROM ${version.table}`)
      .then(([row]) => row?.version ?? 0)
      .catch((error: { code?: string }) => {
        if (error.code === "42P01") return 0;
        throw error;
      });
    if (existing > version.current) {
      throw new Error(
        `the database holds storage of version ${existing}, newer than this FastAgent's ${version.current}`,
      );
    }
    if (existing === version.current) return;
  }

  const madeOrFound = <T>(made: Promise<T>): Promise<T | undefined> =>
    made.catch((error: { code?: string }) => {
      if (!PG_CONCURRENT_DDL.has(error.code ?? "")) throw error;
      return undefined;
    });

  const nonIndexes = statements.filter((s) => !INDEX_STATEMENT.test(s));
  const indexes = statements.filter((s) => INDEX_STATEMENT.test(s));

  for (const statement of nonIndexes) await madeOrFound(db.query(statement));

  const jobs: (() => Promise<void>)[] = [];
  for (const statement of indexes) {
    const job = await madeOrFound(createIndex(db, statement));
    if (job !== undefined) jobs.push(job);
  }
  const built = await Promise.allSettled(jobs.map((job) => job()));
  const failed = built.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed !== undefined) throw failed.reason;

  if (version !== undefined) {
    await db.query(`INSERT INTO ${version.table} (version) VALUES ($1) ON CONFLICT (version) DO NOTHING`, [
      version.current,
    ]);
  }
}

/**
 * Split `text` into parts of at most `bytesPerValue` UTF-8 bytes without splitting inside a multibyte character,
 * or return `undefined` when it fits inline (or `bytesPerValue` is unset).
 */
export function splitPgText(text: string, bytesPerValue: number | undefined): string[] | undefined {
  if (bytesPerValue === undefined) return undefined;
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= bytesPerValue) return undefined;
  const parts: string[] = [];
  for (let start = 0; start < bytes.length; ) {
    let end = Math.min(start + bytesPerValue, bytes.length);
    while (end < bytes.length && end > start && ((bytes[end] as number) & 0xc0) === 0x80) end--;
    if (end === start) throw new Error(`a value of ${bytesPerValue} bytes cannot hold one character`);
    parts.push(bytes.toString("utf8", start, end));
    start = end;
  }
  return parts;
}

/** The refusal of an opener of an instance another process holds: one that passes once that process lets it go. */
export class InstanceHeld extends Unavailable {}

/** How long a holder that stops renewing keeps the instance before a successor may take over. */
export const DEFAULT_LEASE_MS = 30_000;
/** Default maximum wait for a held instance before refusing. */
export const DEFAULT_LEASE_WAIT_MS = DEFAULT_LEASE_MS + 5_000;

/**
 * Renew every quarter of the lease so the third missed tick lands at 3/4 — comfortably past {@link GIVE_UP_AFTER}
 * (2/3) even with timer jitter, while still a full quarter ahead of lease expiry.
 */
const RENEW_EVERY = 1 / 4;
const GIVE_UP_AFTER = 2 / 3;

export interface PgLeaseOptions<TTake = void> {
  /** Lease table with `(instance TEXT PRIMARY KEY, owner TEXT, lease_until TIMESTAMPTZ)`. */
  readonly table: string;
  readonly instance: string;
  readonly owner?: string;
  readonly leaseMs?: number;
  readonly waitMs?: number;
  /** Human-readable description of what else opens the instance, included in the default `InstanceHeld` error. */
  readonly holders?: string;
  /** Invoked once if the lease is lost (taken over or unreachable past `2/3` of `leaseMs`). */
  readonly onLost?: (error: Error) => void;
  /**
   * Optional work executed inside the lease-acquisition transaction right after the lease row is claimed.
   * Throwing aborts the transaction without taking the lease.
   */
  readonly onTake?: (tx: PgExecutor, owner: string) => Promise<TTake>;
  /** Optional custom error constructor when the instance stays held past `waitMs`. */
  readonly formatHeldError?: (info: {
    readonly instance: string;
    readonly until: string;
    readonly holder?: string;
  }) => Error;
  /** Optional custom error constructor when the lease is taken over by another process. */
  readonly formatLostError?: (instance: string) => Error;
}

export interface PgInstanceLease<TTake = void> {
  readonly owner: string;
  readonly taken: TTake;
  readonly lost: Error | undefined;
  /** Refresh and fence the lease inside an active write transaction; triggers `onLost` and throws if lost. */
  assertInTx(tx: PgExecutor): Promise<void>;
  /** Mark the lease lost, stop renewal, and optionally notify `onLost` once. */
  lose(why?: Error, notify?: boolean): Error;
  /** Stop renewal and release the lease row in the database. */
  release(): Promise<void>;
}

/**
 * Acquire and maintain a single-writer instance lease in PostgreSQL or Aurora DSQL.
 * Uses `timestamptz` and `now() + make_interval(...)` semantics verified on both standard PostgreSQL and Aurora DSQL.
 */
export async function acquirePgInstanceLease<TTake = void>(
  db: PgDatabase,
  options: PgLeaseOptions<TTake>,
): Promise<PgInstanceLease<TTake>> {
  const { table, instance } = options;
  if (!SAFE_IDENTIFIER.test(table)) {
    throw new Error(`Invalid PostgreSQL lease table name: ${JSON.stringify(table)}`);
  }
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const waitMs = options.waitMs ?? DEFAULT_LEASE_WAIT_MS;
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
    throw new Error(`PostgreSQL leaseMs must be positive, got ${String(leaseMs)}`);
  }
  if (!Number.isFinite(waitMs) || waitMs < 0) {
    throw new Error(`PostgreSQL waitMs must be non-negative, got ${String(waitMs)}`);
  }
  const owner = options.owner ?? crypto.randomUUID();

  await db.query(`INSERT INTO ${table} (instance) VALUES ($1) ON CONFLICT (instance) DO NOTHING`, [instance]);

  const deadline = Date.now() + waitMs;
  let waiting = false;
  let takenValue!: TTake;

  for (;;) {
    const attempt = await db
      .transaction(async (tx) => {
        const [leased] = await tx.query(
          `UPDATE ${table} SET owner = $2, lease_until = now() + make_interval(secs => $3::double precision / 1000)
            WHERE instance = $1 AND (owner IS NULL OR lease_until < now()) RETURNING instance`,
          [instance, owner, leaseMs],
        );
        if (leased === undefined) return { acquired: false as const };
        const value = options.onTake === undefined ? (undefined as TTake) : await options.onTake(tx, owner);
        return { acquired: true as const, value };
      })
      .catch((error: unknown) => {
        if (isPgConflict(error)) return { acquired: false as const };
        throw error;
      });

    if (attempt.acquired) {
      takenValue = attempt.value;
      break;
    }

    const [held] = await db.query<{ owner: string | null; lease_until: Date | null }>(
      `SELECT owner, lease_until FROM ${table} WHERE instance = $1`,
      [instance],
    );
    const until = held?.lease_until?.toISOString() ?? "now";
    const holder = held?.owner ?? undefined;
    if (Date.now() >= deadline) {
      if (options.formatHeldError !== undefined) {
        throw options.formatHeldError({ instance, until, ...(holder === undefined ? {} : { holder }) });
      }
      const who = options.holders === undefined ? "" : `: ${options.holders} is running`;
      throw new InstanceHeld(
        `the instance "${instance}" is held by another process until ${until}${who}. Stop that one first`,
      );
    }
    if (!waiting) {
      waiting = true;
      log.info(`[fastagent] the instance "${instance}" is held by another process until ${until}; waiting`);
    }
    const remaining = Math.max(5, deadline - Date.now());
    await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, leaseMs / 3, remaining)));
  }

  let lost: Error | undefined;
  let released = false;
  let renewedAt = Date.now();
  let onLost = options.onLost;

  const lose = (why?: Error, notify = false): Error => {
    clearInterval(renewal);
    lost ??=
      why ??
      options.formatLostError?.(instance) ??
      new Error(`the instance "${instance}" was taken over by another process`);
    if (notify) {
      const cb = onLost;
      onLost = undefined;
      cb?.(lost);
    }
    return lost;
  };

  const renewal = setInterval(() => {
    if (released || lost !== undefined) return;
    void db
      .query(
        `UPDATE ${table} SET lease_until = now() + make_interval(secs => $3::double precision / 1000)
          WHERE instance = $1 AND owner = $2 RETURNING instance`,
        [instance, owner, leaseMs],
      )
      .then(
        ([kept]) => {
          if (kept === undefined) lose(undefined, true);
          else renewedAt = Date.now();
        },
        (error: unknown) => {
          const unrenewedMs = Date.now() - renewedAt;
          log.warn(`[fastagent] renewing the lease of "${instance}" failed: ${String(error)}`);
          if (unrenewedMs < leaseMs * GIVE_UP_AFTER) return;
          lose(
            new Error(
              `the instance "${instance}" was given up: its lease went ${Math.round(unrenewedMs / 1000)}s ` +
                `without renewal (${String(error)}), and another process may take it over after ${leaseMs / 1000}s`,
            ),
            true,
          );
        },
      );
  }, leaseMs * RENEW_EVERY);
  renewal.unref();

  return {
    owner,
    taken: takenValue,
    get lost() {
      return lost;
    },
    async assertInTx(tx: PgExecutor) {
      if (lost !== undefined) throw lost;
      const [kept] = await tx.query(
        `UPDATE ${table} SET lease_until = now() + make_interval(secs => $3::double precision / 1000)
          WHERE instance = $1 AND owner = $2 AND lease_until > now() RETURNING instance`,
        [instance, owner, leaseMs],
      );
      if (kept === undefined) throw lose(undefined, true);
      renewedAt = Date.now();
    },
    lose,
    async release() {
      if (released) return;
      released = true;
      onLost = undefined;
      clearInterval(renewal);
      await db.query(`UPDATE ${table} SET owner = NULL, lease_until = NULL WHERE instance = $1 AND owner = $2`, [
        instance,
        owner,
      ]);
    },
  };
}
