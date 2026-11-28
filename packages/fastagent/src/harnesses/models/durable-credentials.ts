/**
 * Harness-neutral durable instance credential store (SQLite via `node:sqlite`, shared PostgreSQL / Aurora DSQL,
 * or in-memory), so remote OAuth logins, refreshed tokens, and device IDs persist across restarts and across
 * harness switches (`pi-durable` <-> `dsh`) without per-harness store code.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { Credential, CredentialInfo } from "@earendil-works/pi-ai";
import { type SqliteStoreHandle, openPostgresStore, openSqliteStore } from "../../instance-store.ts";
import { log } from "../../log.ts";
import type { PostgresDatabase } from "../../postgres.ts";
import type { DurableCredentialStore } from "./credentials.ts";

export interface ManagedDurableCredentialStore extends DurableCredentialStore {
  close(): Promise<void>;
}

const CRED_PREFIX = "cred:";
const DEVICE_KEY = "device_id";

const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS fastagent_credentials (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

const PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS fastagent_credentials (
  instance   TEXT NOT NULL,
  key        TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (instance, key)
);
`;

interface KvBackend {
  get(key: string): Promise<string | undefined>;
  put(key: string, valueJson: string): Promise<void>;
  del(key: string): Promise<void>;
  listPrefix(prefix: string): Promise<Array<{ key: string; valueJson: string }>>;
  close(): Promise<void>;
}

function validCredential(value: unknown): Credential | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const type = (value as { type?: unknown }).type;
  return type === "oauth" || type === "api_key" ? (value as Credential) : undefined;
}

function parseCredential(key: string, raw: string | undefined): Credential | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed = validCredential(JSON.parse(raw));
    if (parsed === undefined) {
      log.warn(`[fastagent] ignoring invalid stored credential for ${key}`);
    }
    return parsed;
  } catch (error) {
    log.warn(
      `[fastagent] ignoring corrupt stored credential for ${key}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

function credentialStoreOver(backend: KvBackend): ManagedDurableCredentialStore {
  const queues = new Map<string, Promise<unknown>>();
  const serialized = <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const previous = queues.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(work);
    const tracked = run.finally(() => {
      if (queues.get(key) === tracked) queues.delete(key);
    });
    queues.set(key, tracked);
    return run;
  };

  return {
    async read(providerId) {
      return parseCredential(providerId, await backend.get(`${CRED_PREFIX}${providerId}`));
    },
    async list() {
      const rows = await backend.listPrefix(CRED_PREFIX);
      const out: CredentialInfo[] = [];
      for (const { key, valueJson } of rows) {
        const providerId = key.slice(CRED_PREFIX.length);
        const cred = parseCredential(providerId, valueJson);
        if (cred !== undefined) out.push({ providerId, type: cred.type });
      }
      return out;
    },
    modify(providerId, fn) {
      return serialized(providerId, async () => {
        const current = parseCredential(providerId, await backend.get(`${CRED_PREFIX}${providerId}`));
        const next = await fn(current);
        if (next === undefined) return current;
        await backend.put(`${CRED_PREFIX}${providerId}`, JSON.stringify(next));
        return next;
      });
    },
    async delete(providerId) {
      await serialized(providerId, () => backend.del(`${CRED_PREFIX}${providerId}`));
    },
    getOrCreateDeviceId() {
      return serialized(DEVICE_KEY, async () => {
        const raw = await backend.get(DEVICE_KEY);
        if (raw !== undefined) {
          try {
            const existing = JSON.parse(raw);
            if (typeof existing === "string" && existing.length > 0) return existing;
            log.warn("[fastagent] stored device_id is invalid; regenerating");
          } catch (error) {
            log.warn(
              `[fastagent] stored device_id is corrupt; regenerating: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        const generated = randomUUID();
        await backend.put(DEVICE_KEY, JSON.stringify(generated));
        return generated;
      });
    },
    close: () => backend.close(),
  };
}

export function memoryDurableCredentialStore(): ManagedDurableCredentialStore {
  const entries = new Map<string, string>();
  return credentialStoreOver({
    async get(key) {
      return entries.get(key);
    },
    async put(key, valueJson) {
      entries.set(key, valueJson);
    },
    async del(key) {
      entries.delete(key);
    },
    async listPrefix(prefix) {
      const out: Array<{ key: string; valueJson: string }> = [];
      for (const [key, valueJson] of entries) {
        if (key.startsWith(prefix)) out.push({ key, valueJson });
      }
      return out;
    },
    async close() {},
  });
}

export function sqliteDurableCredentialStore(filePath: string): ManagedDurableCredentialStore {
  interface OpenedSqliteCreds {
    readonly store: SqliteStoreHandle;
    readonly selectStmt: ReturnType<SqliteStoreHandle["db"]["prepare"]>;
    readonly upsertStmt: ReturnType<SqliteStoreHandle["db"]["prepare"]>;
    readonly deleteStmt: ReturnType<SqliteStoreHandle["db"]["prepare"]>;
    readonly listStmt: ReturnType<SqliteStoreHandle["db"]["prepare"]>;
  }
  let opened: OpenedSqliteCreds | undefined;
  let closed = false;

  const openOrCreate = (): OpenedSqliteCreds => {
    if (closed) throw new Error("credential store is closed");
    if (opened !== undefined) return opened;
    // DELETE journal avoids persistent -wal/-shm sidecar files holding plaintext tokens on disk.
    const store = openSqliteStore(filePath, SQLITE_SCHEMA, { journalMode: "DELETE", mode: 0o600 });
    opened = {
      store,
      selectStmt: store.db.prepare("SELECT value_json FROM fastagent_credentials WHERE key = ?"),
      upsertStmt: store.db.prepare(
        `INSERT INTO fastagent_credentials (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      ),
      deleteStmt: store.db.prepare("DELETE FROM fastagent_credentials WHERE key = ?"),
      listStmt: store.db.prepare("SELECT key, value_json FROM fastagent_credentials WHERE key LIKE ? ORDER BY key ASC"),
    };
    return opened;
  };

  const openIfPresent = (): OpenedSqliteCreds | undefined => {
    if (closed) throw new Error("credential store is closed");
    if (opened !== undefined) return opened;
    return existsSync(filePath) ? openOrCreate() : undefined;
  };

  // Fail fast when an existing credentials file is unreadable/corrupt, without creating one on disk eagerly.
  if (existsSync(filePath)) openOrCreate();

  return credentialStoreOver({
    async get(key) {
      const db = openIfPresent();
      if (db === undefined) return undefined;
      const row = db.selectStmt.get(key) as { value_json?: string } | undefined;
      return row?.value_json;
    },
    async put(key, valueJson) {
      openOrCreate().upsertStmt.run(key, valueJson, Date.now());
    },
    async del(key) {
      openIfPresent()?.deleteStmt.run(key);
    },
    async listPrefix(prefix) {
      const db = openIfPresent();
      if (db === undefined) return [];
      const rows = db.listStmt.all(`${prefix}%`) as Array<{ key: string; value_json: string }>;
      return rows.map((row) => ({ key: row.key, valueJson: row.value_json }));
    },
    async close() {
      if (closed) return;
      closed = true;
      const current = opened;
      opened = undefined;
      if (current !== undefined) await current.store.close();
    },
  });
}

export function postgresDurableCredentialStore(
  database: PostgresDatabase,
  instance: string,
): ManagedDurableCredentialStore {
  const store = openPostgresStore(database, PG_SCHEMA, "credential store");
  return credentialStoreOver({
    async get(key) {
      const rows = await store.query<{ value_json: string }>(
        "SELECT value_json FROM fastagent_credentials WHERE instance = $1 AND key = $2",
        [instance, key],
      );
      return rows[0]?.value_json;
    },
    async put(key, valueJson) {
      await store.query(
        `INSERT INTO fastagent_credentials (instance, key, value_json, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (instance, key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = EXCLUDED.updated_at`,
        [instance, key, valueJson, Date.now()],
      );
    },
    async del(key) {
      await store.query("DELETE FROM fastagent_credentials WHERE instance = $1 AND key = $2", [instance, key]);
    },
    async listPrefix(prefix) {
      const rows = await store.query<{ key: string; value_json: string }>(
        "SELECT key, value_json FROM fastagent_credentials WHERE instance = $1 AND key LIKE $2 ORDER BY key ASC",
        [instance, `${prefix}%`],
      );
      return rows.map((row) => ({ key: row.key, valueJson: row.value_json }));
    },
    close: () => store.close(),
  });
}
