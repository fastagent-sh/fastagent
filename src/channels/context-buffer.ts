/**
 * Generic durable context buffer — the SHARED mechanics behind each stateful channel's
 * "un-summoned group discussion" module (telegram/feishu/slack `context-buffer.ts`): recent
 * un-summoned messages per conversation "place", kept under a char budget and folded into the next
 * answered turn in that place, so a summoned agent has the discussion it didn't see turn-by-turn.
 *
 * Channel-neutral and generic over the entry shape (like ../turn-store.ts): the channel supplies its
 * entry type, the shape validator (state files are an IO boundary — valid JSON of the WRONG shape
 * must degrade exactly like a corrupt file: warn + empty, never flow in as trusted data), the
 * fold-line renderer, and its log label. What stays per channel: the entry type itself, place-key
 * derivation, and buffered-attachment selection (platform resource shapes are real differences).
 *
 * DURABLE, with the consume protocol every channel inherits:
 *  - `push` persists synchronously BEFORE the transport ACK (an ACKed delivery is not redelivered,
 *    so ACK-then-persist would be a silent-loss window): a throw becomes the webhook's 500 and the
 *    platform redelivers once the disk recovers — staged on a copy and rolled back on a failed
 *    write, so the redelivery does not double-append the entry already in memory.
 *  - `peek` renders WITHOUT clearing and snapshots exactly which entries it consumed.
 *  - `commit` removes only that snapshot, by object identity, on the turn's `completed` — so a
 *    failure or crash before `completed` leaves the discussion intact for the next summon, and a
 *    message that arrives while the turn runs survives for the next answered turn (a whole-bucket
 *    delete would lose it).
 */
import { log } from "../log.ts";
import { loadStateFile, saveStateFile } from "./state.ts";

/** Char budget for the per-place buffer — bounds the cost of folding it into a prompt; when exceeded
 *  the OLDEST un-summoned messages are dropped (not a time window: a quiet group keeps its
 *  sparse-but-relevant lines, a busy burst is capped). The `line` renderer is the eviction cost
 *  basis: the budget must price what the fold actually renders, or it would systematically overrun. */
const BUFFER_MAX_CHARS = 4000;

/** How many buffered files and images (each, most recent first) a summon pulls in with the folded
 *  discussion — bounds the latency/token cost of "summarize the file from earlier" against a chatty
 *  group posting many attachments between summons. Skipped ones must be counted into the prompt
 *  note, so the model never sees an attachment reference it silently cannot open. Shared policy:
 *  each channel's attachment collector caps against this. */
export const BUFFER_ATTACH_MAX = 3;

export interface ContextBuffer<E> {
  /** Record an un-summoned message. Persists BEFORE returning (pre-ACK; see the module header). */
  push(placeKey: string, entry: E): void;
  /** Render the fold text and snapshot the consumed entries (see the module header's consume protocol). */
  peek(placeKey: string): { text: string; consumed: E[] };
  /** Remove exactly `consumed` (by identity) — call on the turn's `completed` event, when the folded
   *  discussion provably lives in the durable session. Consumes entries WHOLE, including ones whose
   *  attachments failed to load or were cap-skipped: their text is in the session (keeping them would
   *  re-fold duplicate text), and the prompt note said what is missing; re-post an attachment to use
   *  it. Post-ACK: a failed write is logged, never thrown (it must not abort the turn's delivery). */
  commit(placeKey: string, consumed: E[]): void;
}

export function createContextBuffer<E>(options: {
  path: string;
  /** Log label, e.g. "[telegram]". */
  label: string;
  /** Shape validator for one persisted entry (the IO boundary — see the module header). */
  isEntry: (value: unknown) => value is E;
  /** One fold line for an entry — ALSO the eviction cost basis. */
  line: (entry: E) => string;
}): ContextBuffer<E> {
  const { path, label, isEntry, line } = options;
  const load = (): Map<string, E[]> => {
    const raw = loadStateFile(path);
    if (raw === undefined) return new Map();
    if (
      typeof raw === "object" &&
      raw !== null &&
      !Array.isArray(raw) &&
      Object.values(raw).every((entries) => Array.isArray(entries) && entries.every(isEntry))
    ) {
      return new Map(Object.entries(raw as Record<string, E[]>));
    }
    log.warn(`${label} unexpected shape in ${path} — starting with an empty context buffer`);
    return new Map();
  };
  const buffers = load();
  const persist = (): void => saveStateFile(path, Object.fromEntries(buffers));

  return {
    push(placeKey, entry) {
      const previous = buffers.get(placeKey);
      const entries = previous ? [...previous] : [];
      entries.push(entry);
      let total = entries.reduce((sum, candidate) => sum + line(candidate).length + 1, 0);
      while (entries.length > 1 && total > BUFFER_MAX_CHARS) {
        const dropped = entries.shift();
        if (dropped) total -= line(dropped).length + 1;
      }
      buffers.set(placeKey, entries);
      try {
        persist();
      } catch (error) {
        if (previous) buffers.set(placeKey, previous);
        else buffers.delete(placeKey);
        throw error;
      }
    },
    peek(placeKey) {
      const entries = buffers.get(placeKey) ?? [];
      return { text: entries.map(line).join("\n"), consumed: [...entries] };
    },
    commit(placeKey, consumed) {
      const entries = buffers.get(placeKey);
      if (!entries) return;
      const remaining = entries.filter((entry) => !consumed.includes(entry));
      if (remaining.length === 0) buffers.delete(placeKey);
      else buffers.set(placeKey, remaining);
      try {
        persist();
      } catch (error) {
        log.error(
          `${label} context-buffer write failed post-ACK (a restart may re-fold answered discussion): ${String(error)}`,
        );
      }
    },
  };
}
