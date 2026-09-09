/**
 * Generic durable context buffer — the SHARED mechanics behind each stateful channel's "un-summoned group discussion"
 * module (telegram/feishu/slack `context-buffer.ts`).
 */
import { log } from "../../log.ts";
import { loadStateFile, saveStateFile } from "./state.ts";

/**
 * Char budget for the per-place buffer — bounds the cost of folding it into a prompt; when exceeded the OLDEST
 * un-summoned messages are dropped. Not a time window: a quiet group keeps its sparse-but-relevant lines.
 */
const BUFFER_MAX_CHARS = 4000;

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

/** The folded discussion as it reaches the model — the prompt block, or nothing when the buffer is empty. */
export function discussionBlock(text: string): string {
  return text ? `[recent group discussion:\n${text}\n]\n\n` : "";
}

export interface ContextBuffer<E> {
  /** Record an un-summoned message. */
  push(placeKey: string, entry: E): void;
  /** Render the fold text and snapshot the consumed entries (see the module header's consume protocol). */
  peek(placeKey: string): { text: string; consumed: E[] };
  /**
   * Remove exactly `consumed` (by identity) — call on the turn's `completed` event, when the folded discussion
   * provably lives in the durable session.
   */
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
