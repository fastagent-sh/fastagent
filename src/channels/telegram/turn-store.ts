/**
 * The telegram-shaped turn store: the channel's persisted record (what its runner needs to re-execute a
 * turn), its IO-boundary shape validator, and its arrival ordering, over the generic L1 turn store
 * (../turn-store.ts — the semantics live there: pre-ACK persist, replay on the next start, the poison-
 * turn execution ceiling, the fail-closed attempt bump).
 */
import { type TurnStore, createTurnStore as createGenericTurnStore } from "../turn-store.ts";

/** An accepted turn's persisted intent — the SOURCE for the fields a runner needs to re-execute it
 *  (telegram.ts's PendingTurn derives from this, so a new execution field added here propagates and
 *  cannot silently drop from the persisted record). Minus the live `previewId` (a restart's queue
 *  notice is gone; a replayed turn sends a fresh preview). `attempts` counts how many times this turn
 *  has STARTED executing without finishing (0 until its first run; bumped at each `startAttempt`). */
export interface StoredTurn {
  id: string;
  session: string;
  placeKey: string;
  baseText: string;
  chatId: number | string;
  threadId?: number;
  replyTo?: number;
  imageFileIds: string[];
  fileIds: string[];
  attempts: number;
}

/** State files are an IO boundary: valid JSON of the WRONG SHAPE must degrade like a corrupt file
 *  (warn + empty), not flow in as trusted data (mirrors context-buffer's isBufferEntry). */
function isStoredTurn(t: unknown): t is StoredTurn {
  const r = t as StoredTurn;
  const strings = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === "string");
  return (
    typeof r?.id === "string" &&
    typeof r.session === "string" &&
    typeof r.placeKey === "string" &&
    typeof r.baseText === "string" &&
    (typeof r.chatId === "string" || typeof r.chatId === "number") &&
    (r.threadId === undefined || typeof r.threadId === "number") &&
    (r.replyTo === undefined || typeof r.replyTo === "number") &&
    strings(r.imageFileIds) &&
    strings(r.fileIds) &&
    typeof r.attempts === "number"
  );
}

export function createTurnStore(path: string): TurnStore<StoredTurn> {
  return createGenericTurnStore<StoredTurn>(path, {
    label: "[telegram]",
    isRecord: isStoredTurn,
    // Ids are Telegram update_ids — monotonic — so numeric id order IS arrival order.
    order: (a, b) => Number(a.id) - Number(b.id),
  });
}
