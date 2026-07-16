/**
 * Bounded delivery dedup for message_ids whose webhook handling produced a durable side effect: either
 * an accepted turn intent or a buffered group-context entry. Feishu/Lark document duplicate pushes even
 * after a successful 200 and recommend idempotency on message_id (not event_id). The unfinished-turn
 * store cannot cover a duplicate after completion, and a duplicated background event would otherwise be
 * folded twice.
 *
 * Record only AFTER the pre-ACK side effect is durable: recording first could turn a later state-write
 * failure into silent loss when the platform redelivers. The ring write is best-effort post-persist
 * insurance. A crash between the two writes, a ring-write failure, or an id older than the bounded cap
 * retains L1's at-least-once tail; this is dedup, not exactly-once execution.
 */
import { log } from "../../log.ts";
import { loadStateFile, saveStateFile } from "../state.ts";

export interface SeenRing {
  has(id: string): boolean;
  add(id: string): void;
}

export function createSeenRing(path: string, label = "[feishu]", cap = 2000): SeenRing {
  const load = (): string[] => {
    const raw = loadStateFile(path);
    if (raw === undefined) return [];
    if (Array.isArray(raw) && raw.every((id) => typeof id === "string")) return raw.slice(-cap);
    log.warn(`${label} unexpected shape in ${path} — starting with no seen ids`);
    return [];
  };
  const order = load();
  const ids = new Set(order);
  return {
    has: (id) => ids.has(id),
    add(id) {
      if (ids.has(id)) return;
      ids.add(id);
      order.push(id);
      while (order.length > cap) {
        const evicted = order.shift();
        if (evicted !== undefined) ids.delete(evicted);
      }
      try {
        saveStateFile(path, order);
      } catch (error) {
        log.warn(`${label} seen-ring write failed (delivery dedup is in-memory until restart): ${String(error)}`);
      }
    },
  };
}
