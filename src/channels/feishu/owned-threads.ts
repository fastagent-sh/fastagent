/**
 * Durable ownership index for group threads the channel created from a top-level summon. Feishu/Lark
 * deliver an ordinary thread continuation as `thread_id + root_id`; the root is the original user
 * message the channel reply-threaded under. Keeping that root across restarts lets the default route
 * admit unmentioned continuations only inside Agent-managed threads, never across the whole group.
 */
import { log } from "../../log.ts";
import { loadStateFile, saveStateFile } from "../state.ts";

export interface OwnedFeishuThread {
  rootId: string;
  chatId: string;
  createdAt: number;
}

export interface OwnedFeishuThreads {
  has(chatId: string, rootId: string): boolean;
  /** Idempotent, synchronous, pre-ACK persistence. A failed write throws so the platform redelivers. */
  add(chatId: string, rootId: string): void;
}

function isRecord(value: unknown): value is OwnedFeishuThread {
  const record = value as OwnedFeishuThread;
  return (
    typeof record?.rootId === "string" &&
    typeof record.chatId === "string" &&
    typeof record.createdAt === "number" &&
    Number.isFinite(record.createdAt)
  );
}

export function createOwnedFeishuThreads(
  path: string,
  label: string,
  now: () => number = Date.now,
): OwnedFeishuThreads {
  const raw = loadStateFile(path);
  let records = new Map<string, OwnedFeishuThread>();
  if (raw !== undefined) {
    if (
      typeof raw === "object" &&
      raw !== null &&
      !Array.isArray(raw) &&
      Object.entries(raw).every(([rootId, record]) => isRecord(record) && record.rootId === rootId)
    ) {
      records = new Map(Object.entries(raw as Record<string, OwnedFeishuThread>));
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
      if (existing?.chatId === chatId) return;
      const next = new Map(records);
      next.set(rootId, { rootId, chatId, createdAt: now() });
      // Persist the staged copy first: an IO failure must not leave memory claiming durability the file
      // does not have. The webhook remains un-ACKed and the platform can redeliver after recovery.
      saveStateFile(path, Object.fromEntries(next));
      records = next;
    },
  };
}
