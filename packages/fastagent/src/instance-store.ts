/**
 * Shared SQLite and PostgreSQL store opening, schema migration, and transient-error mapping
 * used by harness-neutral persistence modules (`conversations.ts`, `durable-credentials.ts`).
 */
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { agentError } from "@fastagent-sh/client/agent-api";
import { type PostgresDatabase, acquirePgDatabase, isTransientPgError } from "./postgres.ts";
import { PG_CONCURRENT_DDL } from "./postgres-kit.ts";

export interface SqliteStoreHandle {
  readonly db: DatabaseSync;
  close(): Promise<void>;
}

/**
 * Open a local SQLite database with the requested journal mode, run `schema`, and apply optional file mode (`0o600`
 * for secret-bearing stores).
 */
export function openSqliteStore(
  filePath: string,
  schema: string,
  options: { readonly journalMode: "WAL" | "DELETE"; readonly mode?: number },
): SqliteStoreHandle {
  mkdirSync(dirname(filePath), {
    recursive: true,
    ...(options.mode === undefined ? {} : { mode: 0o700 }),
  });
  const db = new DatabaseSync(filePath);
  try {
    db.exec(`PRAGMA journal_mode = ${options.journalMode}; PRAGMA busy_timeout = 5000;`);
    db.exec(schema);
    if (options.mode !== undefined) {
      try {
        chmodSync(filePath, options.mode);
      } catch {
        // Non-POSIX filesystems may reject chmod; best-effort owner-only permissions.
      }
    }
  } catch (error) {
    try {
      db.close();
    } catch {
      // Preserve the original open/schema failure.
    }
    throw error;
  }
  let closed = false;
  return {
    db,
    async close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}

const PG_UNDEFINED_TABLE = "42P01";

export interface PostgresStoreHandle {
  query<T extends object = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]>;
  /** Query without running DDL first; returns `undefined` when the table does not exist yet (PG SQLSTATE `42P01`). */
  queryIfExists<T extends object = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<T[] | undefined>;
  close(): Promise<void>;
}

/**
 * Open an instance-scoped PostgreSQL store handle with single-flight idempotent DDL migration and transient error
 * classification (`unavailable`).
 */
export function openPostgresStore(database: PostgresDatabase, schema: string, label: string): PostgresStoreHandle {
  const { db, owned } = acquirePgDatabase(database);
  let migrated: Promise<void> | undefined;
  let closed = false;

  const mapError = (error: unknown): unknown => {
    if (!isTransientPgError(error)) return error;
    const message = error instanceof Error ? error.message : String(error);
    return agentError("unavailable", `${label} temporarily unavailable: ${message}`);
  };

  const ensureSchema = (): Promise<void> => {
    migrated ??= db
      .query(schema)
      .then(() => undefined)
      .catch((error: { code?: string }) => {
        if (PG_CONCURRENT_DDL.has(error.code ?? "")) return;
        migrated = undefined;
        throw mapError(error);
      });
    return migrated;
  };

  return {
    async query<T extends object = Record<string, unknown>>(text: string, params?: readonly unknown[]) {
      await ensureSchema();
      try {
        return await db.query<T>(text, params);
      } catch (error) {
        throw mapError(error);
      }
    },
    async queryIfExists<T extends object = Record<string, unknown>>(text: string, params?: readonly unknown[]) {
      try {
        return await db.query<T>(text, params);
      } catch (error) {
        if ((error as { code?: string } | null)?.code === PG_UNDEFINED_TABLE) return undefined;
        throw mapError(error);
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      if (owned) await db.close();
    },
  };
}
