/**
 * Harness-neutral PostgreSQL storage primitives shared across `pi-durable`, `@fastagent-sh/harness-dsh`, and future
 * server harnesses: idempotent DDL migration, OCC conflict detection, pooled batch lease renewal, and cooperative idle
 * lease handoff.
 */
import { log } from "./log.ts";
import type { PgDatabase, PgExecutor, SharedPostgresHandle } from "./postgres.ts";
import { Unavailable } from "./unavailable.ts";

/**
 * PostgreSQL SQLSTATE codes raised when two processes race on `CREATE ... IF NOT EXISTS`:
 * duplicate_table (`42P07`), duplicate_object (`42710`), or unique_violation on pg_catalog (`23505`).
 */
export const PG_CONCURRENT_DDL = new Set(["42P07", "42710", "23505"]);

/** Whether `error` is a PostgreSQL serialization conflict (`40001`). */
export function isPgConflict(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return code === "40001";
}

const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export interface MigratePgSchemaOptions {
  /** Optional schema version table checked before DDL and recorded once all tables and indexes are ready. */
  readonly version?: {
    readonly table: string;
    readonly current: number;
    readonly minimum?: number;
  };
}

/**
 * Apply idempotent table and index DDL statements to PostgreSQL, ignoring concurrent `CREATE ... IF NOT EXISTS` races.
 */
export async function migratePgSchema(
  db: PgExecutor,
  statements: readonly string[],
  options: MigratePgSchemaOptions = {},
): Promise<void> {
  const { version } = options;
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
    const minimum = version.minimum ?? version.current;
    if (existing > 0 && existing < minimum) {
      throw new Error(
        `the database holds incompatible storage of version ${existing} (this FastAgent requires version ${minimum})`,
      );
    }
    if (existing === version.current) return;
  }

  for (const statement of statements) {
    await db.query(statement).catch((error: { code?: string }) => {
      if (!PG_CONCURRENT_DDL.has(error.code ?? "")) throw error;
    });
  }

  if (version !== undefined) {
    await db.query(`INSERT INTO ${version.table} (version) VALUES ($1) ON CONFLICT (version) DO NOTHING`, [
      version.current,
    ]);
  }
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
/** Maximum instances renewed in a single batch SQL statement. */
const RENEW_BATCH_SIZE = 500;

export interface PgLeaseHandoff {
  readonly canYield: () => boolean;
  readonly onHandoff: () => void;
}

interface LeaseRenewalEntry {
  readonly instance: string;
  readonly owner: string;
  readonly leaseMs: number;
  readonly handoff: PgLeaseHandoff | undefined;
  readonly isActive: () => boolean;
  readonly lose: (why?: Error, notify?: boolean) => Error;
  readonly triggerHandoff: () => void;
  renewedAt: number;
}

interface LeaseBucket {
  readonly table: string;
  readonly leaseMs: number;
  readonly entries: Set<LeaseRenewalEntry>;
  readonly timer: ReturnType<typeof setInterval>;
  inFlight: boolean;
}

/**
 * Renew a batch of leases in one SQL statement, expire stale handoff requests older than `leaseMs`, detect lost
 * leases, and trigger cooperative handoff for idle instances.
 */
async function renewLeaseBatch(
  db: Pick<PgDatabase, "query">,
  table: string,
  leaseMs: number,
  entries: readonly LeaseRenewalEntry[],
): Promise<void> {
  const active = entries.filter((entry) => entry.isActive());
  if (active.length === 0) return;

  for (let offset = 0; offset < active.length; offset += RENEW_BATCH_SIZE) {
    const batch = active.slice(offset, offset + RENEW_BATCH_SIZE);
    try {
      const rows = await db.query<{ instance: string; handoff_requested_at: Date | null }>(
        `UPDATE ${table}
          SET lease_until = now() + make_interval(secs => $3::double precision / 1000),
              handoff_requested_at = CASE
                WHEN handoff_requested_at < now() - make_interval(secs => $3::double precision / 1000)
                  THEN NULL
                ELSE handoff_requested_at
              END
          WHERE (instance, owner) IN (SELECT * FROM unnest($1::text[], $2::text[]))
          RETURNING instance, handoff_requested_at`,
        [batch.map((e) => e.instance), batch.map((e) => e.owner), leaseMs],
      );
      const keptByInstance = new Map<string, Date | null>(rows.map((r) => [r.instance, r.handoff_requested_at]));
      const now = Date.now();
      for (const entry of batch) {
        if (!entry.isActive()) continue;
        if (!keptByInstance.has(entry.instance)) {
          entry.lose(undefined, true);
          continue;
        }
        entry.renewedAt = now;
        const requestedAt = keptByInstance.get(entry.instance);
        if (requestedAt !== null && requestedAt !== undefined && entry.handoff?.canYield() === true) {
          entry.triggerHandoff();
        }
      }
    } catch (error) {
      const now = Date.now();
      for (const entry of batch) {
        if (!entry.isActive()) continue;
        const unrenewedMs = now - entry.renewedAt;
        log.warn(`[fastagent] renewing the lease of "${entry.instance}" failed: ${String(error)}`);
        if (unrenewedMs < leaseMs * GIVE_UP_AFTER) continue;
        entry.lose(
          new Error(
            `the instance "${entry.instance}" was given up: its lease went ${Math.round(unrenewedMs / 1000)}s ` +
              `without renewal (${String(error)}), and another process may take it over after ${leaseMs / 1000}s`,
          ),
          true,
        );
      }
    }
  }
}

/**
 * Coalesced per-pool lease renewer: groups all active leases sharing a `SharedPostgresHandle` by `(table, leaseMs)`
 * into one interval timer per bucket, reducing N-tenant idle heartbeat traffic from O(N) queries/tick to O(1).
 */
class PgLeasePool {
  private readonly buckets = new Map<string, LeaseBucket>();
  private readonly db: PgDatabase;
  private disposed = false;

  constructor(handle: SharedPostgresHandle) {
    this.db = handle.borrowed;
    handle.onClose(() => this.dispose());
  }

  register(table: string, entry: LeaseRenewalEntry): () => void {
    if (this.disposed) return () => {};
    const key = `${table}:${entry.leaseMs}`;
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      const entries = new Set<LeaseRenewalEntry>();
      const created: LeaseBucket = {
        table,
        leaseMs: entry.leaseMs,
        entries,
        inFlight: false,
        timer: setInterval(() => {
          if (created.inFlight || created.entries.size === 0) return;
          created.inFlight = true;
          void renewLeaseBatch(this.db, created.table, created.leaseMs, [...created.entries]).finally(() => {
            created.inFlight = false;
          });
        }, entry.leaseMs * RENEW_EVERY),
      };
      created.timer.unref();
      this.buckets.set(key, created);
      bucket = created;
    }
    bucket.entries.add(entry);
    const activeBucket = bucket;
    return () => {
      activeBucket.entries.delete(entry);
      if (activeBucket.entries.size === 0) {
        clearInterval(activeBucket.timer);
        if (this.buckets.get(key) === activeBucket) this.buckets.delete(key);
      }
    };
  }

  private dispose(): void {
    this.disposed = true;
    for (const bucket of this.buckets.values()) {
      clearInterval(bucket.timer);
      bucket.entries.clear();
    }
    this.buckets.clear();
  }
}

const poolRenewers = new WeakMap<SharedPostgresHandle, PgLeasePool>();

function leasePoolFor(handle: SharedPostgresHandle): PgLeasePool {
  let pool = poolRenewers.get(handle);
  if (pool === undefined) {
    pool = new PgLeasePool(handle);
    poolRenewers.set(handle, pool);
  }
  return pool;
}

export interface PgLeaseOptions<TTake = void> {
  /** Lease table with `(instance TEXT PRIMARY KEY, owner TEXT, lease_until TIMESTAMPTZ, handoff_requested_at TIMESTAMPTZ)`. */
  readonly table: string;
  readonly instance: string;
  readonly owner?: string;
  readonly leaseMs?: number;
  readonly waitMs?: number;
  /** Optional shared pool handle to coalesce lease renewals across all instances on the same pool. */
  readonly pool?: SharedPostgresHandle;
  /**
   * Optional cooperative idle handoff hooks: when another process is waiting to open this instance and `canYield()`
   * returns `true`, the lease stops renewing, fences further writes, and invokes `onHandoff()` (never `onLost`).
   */
  readonly handoff?: PgLeaseHandoff;
  /** Human-readable description of what else opens the instance, included in the default `InstanceHeld` error. */
  readonly holders?: string;
  /** Invoked once if the lease is lost unexpectedly (taken over or unreachable past `2/3` of `leaseMs`). */
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
  /** Mark the lease lost, stop renewal, and optionally notify `onLost` once. */
  lose(why?: Error, notify?: boolean): Error;
  /** Stop renewal and release the lease row in the database. */
  release(): Promise<void>;
}

/**
 * Acquire and maintain a single-writer instance lease in PostgreSQL.
 * - Uses `timestamptz` and `now() + make_interval(...)` semantics in PostgreSQL.
 * - When `pool` is provided, coalesces renewals across all instances sharing that pool into one batched query per tick.
 * - When waiting (`waitMs > 0`), writes `handoff_requested_at` so an idle holder yields cleanly instead of blocking until expiry.
 */
export async function acquirePgInstanceLease<TTake = void>(
  db: Pick<PgDatabase, "query" | "transaction">,
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
          `UPDATE ${table}
            SET owner = $2,
                lease_until = now() + make_interval(secs => $3::double precision / 1000),
                handoff_requested_at = NULL
            WHERE instance = $1 AND (owner IS NULL OR lease_until < now())
            RETURNING instance`,
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

    const [held] = await db.query<{
      owner: string | null;
      lease_until: Date | null;
      handoff_requested_at: Date | null;
    }>(`SELECT owner, lease_until, handoff_requested_at FROM ${table} WHERE instance = $1`, [instance]);
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

    // Signal the current holder that another process is waiting to take over; an idle holder yields on its next tick.
    if (held?.handoff_requested_at === null && holder !== undefined) {
      await db
        .query(
          `UPDATE ${table} SET handoff_requested_at = now()
            WHERE instance = $1 AND owner IS NOT NULL AND owner <> $2 AND handoff_requested_at IS NULL`,
          [instance, owner],
        )
        .catch((error: unknown) => {
          if (!isPgConflict(error)) throw error;
        });
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
  let onLost = options.onLost;
  let onHandoff = options.handoff?.onHandoff;
  let unregister = () => {};

  const lose = (why?: Error, notify = false): Error => {
    unregister();
    onHandoff = undefined;
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

  const triggerHandoff = (): void => {
    if (released || lost !== undefined) return;
    unregister();
    onLost = undefined;
    lost = new Error(`the instance "${instance}" was handed off while idle to another process`);
    const cb = onHandoff;
    onHandoff = undefined;
    cb?.();
  };

  const entry: LeaseRenewalEntry = {
    instance,
    owner,
    leaseMs,
    handoff: options.handoff,
    isActive: () => !released && lost === undefined,
    lose,
    triggerHandoff,
    renewedAt: Date.now(),
  };

  if (options.pool !== undefined) {
    unregister = leasePoolFor(options.pool).register(table, entry);
  } else {
    let inFlight = false;
    const renewal = setInterval(() => {
      if (inFlight || !entry.isActive()) return;
      inFlight = true;
      void renewLeaseBatch(db, table, leaseMs, [entry]).finally(() => {
        inFlight = false;
      });
    }, leaseMs * RENEW_EVERY);
    renewal.unref();
    unregister = () => clearInterval(renewal);
  }

  return {
    owner,
    taken: takenValue,
    get lost() {
      return lost;
    },
    lose,
    async release() {
      if (released) return;
      released = true;
      onLost = undefined;
      onHandoff = undefined;
      unregister();
      await db.query(
        `UPDATE ${table} SET owner = NULL, lease_until = NULL, handoff_requested_at = NULL
          WHERE instance = $1 AND owner = $2`,
        [instance, owner],
      );
    },
  };
}
