/**
 * A storage only one process opens: the instance's SQLite database, held by the one process that owns the instance
 * (architecture.md §4.3), and the database of an `invoke --session` conversation. pi-durable does no cross-process locking of its own, and in WAL mode SQLite lets a second process open and
 * write the same file, which would resume and run the same messages twice. So the database is opened in EXCLUSIVE
 * locking mode: the first access takes the file's lock and keeps it until the process closes it or dies, and a second
 * opener is refused. Locally that is SQLite's own POSIX lock. On a file system where those fail (AgentCore's session
 * storage), the database locks by a `<path>.lock` directory instead, which outlives a stopped microVM: the process
 * that holds the deployment's lease knows such a lock is a dead process's, removes it, and says so.
 */
import { existsSync, mkdirSync, rmdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Storage } from "@earendil-works/pi-durable";
import { NodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { log } from "../../log.ts";

export type StorageLocking = "posix" | "leased-dotfile";

/** How long an opener waits for a lock: long enough for a restart's old process to finish closing. */
const BUSY_TIMEOUT_MS = 5_000;
const SQLITE_BUSY = 5;

/** Open the database at `path`, or say who holds it: `holders` names the commands that open it. */
export async function openLockedStorage(path: string, locking: StorageLocking, holders: string): Promise<Storage> {
  mkdirSync(dirname(path), { recursive: true });
  if (locking === "leased-dotfile") breakStaleLock(`${path}.lock`);
  const location = locking === "posix" ? path : `file:${path}?vfs=unix-dotfile`;
  const database = new DatabaseSync(location, { timeout: BUSY_TIMEOUT_MS });
  const adapter = new NodeSqliteDatabase(database);
  try {
    // In this order: an exclusive lock keeps WAL's index in this process's memory, so no shared memory is needed.
    await adapter.exec("PRAGMA locking_mode = EXCLUSIVE");
    await adapter.exec("PRAGMA journal_mode = WAL");
    await adapter.exec("PRAGMA synchronous = NORMAL");
    return await SqliteStorage.open(adapter);
  } catch (error) {
    // The connection only: the adapter's close checkpoints first, which a refused opener cannot do.
    database.close();
    if ((error as { errcode?: unknown }).errcode !== SQLITE_BUSY) throw error;
    throw new Error(`the storage ${path} is held by another process: ${holders} is running. Stop that one first`, {
      cause: error,
    });
  }
}

function breakStaleLock(lock: string): void {
  if (!existsSync(lock)) return;
  rmdirSync(lock);
  log.warn(`[fastagent] removed ${lock}: a process that held the storage stopped without releasing it`);
}
