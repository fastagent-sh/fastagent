/**
 * Write-through CACHE of managed group-thread roots. The authoritative predicate is a property of the
 * thread itself — its root message @mentions this bot (a summon) — re-derivable from the platform at
 * any time via getMessage(root_id). This file only avoids that lookup on the hot path; losing it
 * (redeploy without a volume, a new machine) costs one re-check per thread. The one exception: a
 * RECALLED root can no longer prove itself, so that thread falls back to @-only after cache loss.
 * (The on-disk name `owned-threads.json` predates the cache semantics and is kept for state compat.)
 */
import { log } from "../../log.ts";
import { loadStateFile, saveStateFile } from "../state.ts";

interface FeishuManagedRoot {
  rootId: string;
  chatId: string;
  createdAt: number;
}

interface FeishuManagedRoots {
  has(chatId: string, rootId: string): boolean;
  /** Idempotent. Memory-first; a failed cache write is a warning (the root check re-derives it), never
   *  a failed delivery. */
  add(chatId: string, rootId: string): void;
}

/** Cap on cached roots: dropping one costs a single `getMessage` to re-derive, so an unbounded file
 *  (and an unbounded boot-time load) would buy nothing. Oldest entries are evicted first. */
const MAX_ROOTS = 5000;

function isRecord(value: unknown): value is FeishuManagedRoot {
  const record = value as FeishuManagedRoot;
  return (
    typeof record?.rootId === "string" &&
    typeof record.chatId === "string" &&
    typeof record.createdAt === "number" &&
    Number.isFinite(record.createdAt)
  );
}

export function createFeishuManagedRoots(
  path: string,
  label: string,
  now: () => number = Date.now,
): FeishuManagedRoots {
  const raw = loadStateFile(path);
  const records = new Map<string, FeishuManagedRoot>();
  if (raw !== undefined) {
    if (
      typeof raw === "object" &&
      raw !== null &&
      !Array.isArray(raw) &&
      Object.entries(raw).every(([rootId, record]) => isRecord(record) && record.rootId === rootId)
    ) {
      for (const [rootId, record] of Object.entries(raw as Record<string, FeishuManagedRoot>)) {
        records.set(rootId, record);
      }
    } else {
      log.warn(`${label} unexpected shape in ${path} — starting with no managed group threads`);
    }
  }

  return {
    has(chatId, rootId) {
      const record = records.get(rootId);
      return record?.chatId === chatId;
    },
    add(chatId, rootId) {
      const existing = records.get(rootId);
      if (existing !== undefined) {
        // Roots are globally unique; a second chat claiming one is a protocol anomaly. First write
        // wins — silently rebinding the chat would let a later event steal an established thread.
        if (existing.chatId !== chatId) {
          log.warn(`${label} root ${rootId} is already bound to chat ${existing.chatId} — ignoring chat ${chatId}`);
        }
        return;
      }
      records.set(rootId, { rootId, chatId, createdAt: now() });
      // Insertion order is arrival order (the loaded file preserves it), so the first key is the oldest.
      while (records.size > MAX_ROOTS) {
        const oldest = records.keys().next().value;
        if (oldest === undefined) break;
        records.delete(oldest);
      }
      try {
        saveStateFile(path, Object.fromEntries(records));
      } catch (error) {
        // Cache only: memory stays correct for this process, and the whole map is rewritten on the next
        // successful add — so a failed write costs durability only until then (or until a restart, where
        // the platform root check re-derives it).
        log.warn(`${label} could not persist managed-thread cache ${path}: ${String(error)}`);
      }
    },
  };
}
