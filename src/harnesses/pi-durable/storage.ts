/**
 * The instance's storage: one SQLite database, opened by the one process that owns the instance (architecture.md
 * §4.3). Locally SQLite's own locks keep a second opener out, and die with their process. On a file system where they
 * fail (AgentCore's session storage), the database locks by a `<path>.lock` directory instead, which outlives a
 * stopped microVM: the process that holds the deployment's lease knows such a lock is a dead process's, removes it,
 * and says so.
 */
import { existsSync, mkdirSync, rmdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Storage } from "@earendil-works/pi-durable";
import { NodeSqliteDatabase, openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { log } from "../../log.ts";

export type StorageLocking = "posix" | "leased-dotfile";

export async function openInstanceStorage(path: string, locking: StorageLocking): Promise<Storage> {
  if (locking === "posix") return openNodeSqliteStorage(path);
  mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  if (existsSync(lock)) {
    rmdirSync(lock);
    log.warn(`[fastagent] removed ${lock}: a process that held the storage stopped without releasing it`);
  }
  const database = new DatabaseSync(`file:${path}?vfs=unix-dotfile`);
  const adapter = new NodeSqliteDatabase(database);
  try {
    // In this order: an exclusive lock keeps WAL's index in this process's memory, so no shared memory is needed.
    await adapter.exec("PRAGMA locking_mode = EXCLUSIVE");
    await adapter.exec("PRAGMA journal_mode = WAL");
    await adapter.exec("PRAGMA synchronous = NORMAL");
    return await SqliteStorage.open(adapter);
  } catch (error) {
    await adapter.close();
    throw error;
  }
}
