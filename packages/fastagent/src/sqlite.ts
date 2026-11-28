/**
 * Lazy `node:sqlite` loader: imports `node:sqlite` only when an instance actually opens a local SQLite database,
 * keeping PostgreSQL and in-memory cloud hosts free of import-time SQLite module loads.
 */
import { createRequire } from "node:module";
import type { DatabaseSync, DatabaseSyncOptions } from "node:sqlite";

const require = createRequire(import.meta.url);
let SqliteDatabaseSync: typeof DatabaseSync | undefined;

export function openDatabaseSync(path: string, options?: DatabaseSyncOptions): DatabaseSync {
  SqliteDatabaseSync ??= (require("node:sqlite") as typeof import("node:sqlite")).DatabaseSync;
  return options === undefined ? new SqliteDatabaseSync(path) : new SqliteDatabaseSync(path, options);
}
