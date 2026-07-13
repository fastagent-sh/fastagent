/**
 * Accepted-turn dedup: a bounded, persisted ring of message_ids the channel has ACCEPTED. The platform
 * redelivers events it thinks undelivered AND documents duplicate pushes in "special scenarios", keying
 * idempotency on message_id (its own guidance: dedup on message_id, not event_id). The turn-store alone
 * cannot cover the tail: once a completed turn's intent is removed, a late redelivery would re-run it —
 * this ring is what refuses that. Only ACCEPTED (routed) messages enter: ignored events are side-effect-
 * free, so recording them would just churn the ring.
 *
 * Best-effort durability (post-decision insurance, not the pre-ACK intent): a failed write logs and
 * moves on — the exposure is a re-run after BOTH a completed turn and a redelivery straddle a crash,
 * the same at-least-once tail the turn-store documents.
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
    if (Array.isArray(raw) && raw.every((x) => typeof x === "string")) return raw.slice(-cap);
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
      } catch (e) {
        log.warn(`${label} seen-ring write failed (dedup degrades to the turn-store window): ${String(e)}`);
      }
    },
  };
}
