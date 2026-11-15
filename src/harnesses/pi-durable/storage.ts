/**
 * A storage only one process opens: the instance's SQLite database, held by the one process that owns the instance
 *, and `fastagent invoke`'s own. pi-durable does no cross-process locking of its own, and in
 * WAL mode SQLite lets a second process open and write the same file, which would resume and run the same messages
 * twice. So the database is opened in EXCLUSIVE locking mode: the first access takes the file's lock and keeps it
 * until the process closes it or dies, and a second opener is refused.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Storage } from "@earendil-works/pi-durable";
import { NodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";

/** How long an opener waits for a lock: long enough for a restart's old process to finish closing. */
const BUSY_TIMEOUT_MS = 5_000;
const SQLITE_BUSY = 5;

/**
 * Open the database at `path`, or refuse, naming `holders` (what else opens it) when given. A database another process
 * holds is waited for `busyTimeoutMs` before the refusal.
 */
export async function openLockedStorage(
  path: string,
  holders?: string,
  busyTimeoutMs = BUSY_TIMEOUT_MS,
): Promise<Storage> {
  mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path, { timeout: busyTimeoutMs });
  const adapter = new NodeSqliteDatabase(database);
  try {
    // In this order: an exclusive lock keeps WAL's index in this process's memory, so no shared memory is needed.
    await adapter.exec("PRAGMA locking_mode = EXCLUSIVE");
    await adapter.exec("PRAGMA journal_mode = WAL");
    await adapter.exec("PRAGMA synchronous = NORMAL");
    return await SqliteStorage.open(adapter);
  } catch (error) {
    // The connection only: the adapter's close checkpoints first, which a refused opener cannot do. Already closed
    // when the storage refused the database itself (a schema it does not know), and closing it again would hide why.
    if (database.isOpen) database.close();
    if ((error as { errcode?: unknown }).errcode !== SQLITE_BUSY) throw error;
    const who = holders === undefined ? "" : `: ${holders} is running`;
    throw new Error(`the storage ${path} is held by another process${who}. Stop that one first`, { cause: error });
  }
}
