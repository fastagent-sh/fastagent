/**
 * Generic durable context buffer — the SHARED mechanics behind each stateful channel's "un-summoned group discussion"
 * module (telegram/feishu/slack `context-buffer.ts`). Generic over the entry shape: the channel supplies its entry
 * type, the shape validator, the fold-line renderer and its log label.
 *
 * `push` persists synchronously BEFORE the transport ACK (an ACKed delivery is not redelivered, so ACK-then-persist
 * would be a silent-loss window): a throw becomes the webhook's 500 and the platform redelivers. Nothing is consumed:
 * a turn folds the entries between the ask its session was last sent and its own (`fold`), so the session is the one
 * record of what was read, and the oldest entries leave only when the budget does.
 *
 * State files are an IO boundary: valid JSON of the WRONG shape degrades exactly like a corrupt file (warn + empty),
 * never flowing in as trusted data.
 */
import { log } from "../../log.ts";
import type { Discussion } from "./place-history.ts";
import { loadStateFile, saveStateFile } from "../../state-file.ts";

/**
 * Char budget for the per-place buffer — bounds the cost of folding it into a prompt; when exceeded the OLDEST
 * un-summoned messages are dropped. Not a time window: a quiet group keeps its sparse-but-relevant lines.
 */
export const BUFFER_MAX_CHARS = 4000;

/** Per-message bound INSIDE that budget. */
export const BUFFER_LINE_MAX_CHARS = 280;

/** How many buffered files and images (each, most recent first) a summon pulls in with the folded discussion. */
export const BUFFER_ATTACH_MAX = 3;

/**
 * Keep the newest {@link BUFFER_ATTACH_MAX} refs of one kind. The overflow is COUNTED, not silently dropped: the
 * prompt note tells the model what it is not holding, so it cannot pretend to have read it.
 */
export function capBufferedRefs<R>(refs: R[]): { kept: R[]; skipped: number } {
  return { kept: refs.slice(-BUFFER_ATTACH_MAX), skipped: Math.max(0, refs.length - BUFFER_ATTACH_MAX) };
}

/**
 * The folded discussion as it reaches the model — the prompt block, or nothing when the buffer is empty. "Here", not
 * "group": a direct chat's buffer holds what the agent sent there itself.
 */
export function discussionBlock(text: string): string {
  return text ? `[recent discussion here:\n${text}\n]\n\n` : "";
}

export interface ContextBuffer<E> {
  /** Record an un-summoned message. */
  push(placeKey: string, entry: E): void;
  /** The place's entries after `after` and up to `until` (positions: see `createContextBuffer`), rendered for a turn. */
  fold(placeKey: string, range: { after?: number; until: number }): Discussion<E>;
}

export function createContextBuffer<E>(options: {
  path: string;
  /** Log label, e.g. "[telegram]". */
  label: string;
  /** Shape validator for one persisted entry (the IO boundary — see the module header). */
  isEntry: (value: unknown) => value is E;
  /** One fold line for an entry — ALSO the eviction cost basis. */
  line: (entry: E) => string;
  /** Where the entry stands in its place: the platform's message id, which grows with the discussion. */
  position: (entry: E) => number;
}): ContextBuffer<E> {
  const { path, label, isEntry, line, position } = options;
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
        // Staged on a copy, rolled back on a failed write, then rethrown: the throw becomes the webhook's 500 and the
        // platform redelivers, so an entry left in memory here would be appended a second time.
        if (previous) buffers.set(placeKey, previous);
        else buffers.delete(placeKey);
        throw error;
      }
    },
    fold(placeKey, { after, until }) {
      const folded = (buffers.get(placeKey) ?? []).filter(
        (entry) => (after === undefined || position(entry) > after) && position(entry) <= until,
      );
      return { text: folded.map(line).join("\n"), folded };
    },
  };
}
