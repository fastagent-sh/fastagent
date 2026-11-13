/**
 * Generic durable context buffer — the SHARED mechanics behind a channel's "un-summoned group discussion" record, for a
 * platform whose API has no history read (Telegram). Generic over the entry shape: the channel supplies its entry type,
 * the shape validator, the fold-line renderer and its log label.
 *
 * What it is: a copy of what a platform will not show again, kept so a turn can read what was said before its ask. Not
 * the place's memory (the platform is that wherever it can be read) and not the agent's (the session is: what a turn
 * folded lives there, and the buffer consumes nothing). So it is kept for a time, not for ever, and not for a size:
 * an entry older than {@link BUFFER_RETENTION_MS} is dropped, and a place that lost entries says so to the next turn that
 * reads it (`expiredThrough`), so a missing part of a place is never taken for a quiet one. What one turn folds is
 * bounded by its model's window ({@link foldBudget}), not by what the buffer holds.
 *
 * `push` persists synchronously BEFORE the transport ACK (an ACKed delivery is not redelivered, so ACK-then-persist
 * would be a silent-loss window): a throw becomes the webhook's 500 and the platform redelivers. A place is a file of its
 * own, so a push rewrites that place and not every place: with a time bound and no size bound, one file for all of them
 * grows with the busiest deployment, and the write before the ACK with it.
 *
 * State files are an IO boundary: valid JSON of the WRONG shape degrades exactly like a corrupt file (warn + empty),
 * never flowing in as trusted data.
 */
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { log } from "../../log.ts";
import type { Discussion } from "./history.ts";
import { fitToBudget } from "./fold-budget.ts";
import { ensureStateHome, loadStateFile, saveStateFile } from "../../state-file.ts";

/** How long an un-summoned message is kept: what nobody has asked about in this long is not read again. */
const BUFFER_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

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
  /**
   * The place's entries after `after` and up to `until` (positions: see `createContextBuffer`), rendered for a turn into
   * `budget` characters, minus the ones `skip` names: what the reading conversation's own session already holds. Says,
   * in its text, what the budget left out and what the retention dropped.
   */
  fold(
    placeKey: string,
    range: { after?: number; until: number; budget: number; skip?: (entry: E) => boolean },
  ): Discussion<E>;
}

/** One place's record: its entries, the newest position the retention has dropped from it, and when it last did. */
interface Place<E> {
  entries: E[];
  expiredThrough?: number;
  /** When something was last dropped (ms): the note of it is kept one more retention, then the place is forgotten. */
  droppedAt?: number;
}

/** How often a quiet place's expired entries are swept from its file: a place is also tidied by its own next push. */
const SWEEP_EVERY_MS = 60 * 60 * 1000;

export function createContextBuffer<E>(options: {
  /** The directory the places are kept in, a file each. */
  dir: string;
  /** Log label, e.g. "[telegram]". */
  label: string;
  /** Shape validator for one persisted entry (the IO boundary — see the module header). */
  isEntry: (value: unknown) => value is E;
  /** One fold line for an entry. */
  line: (entry: E) => string;
  /**
   * Where the entry stands in its place: the platform's message id, which grows with the discussion. `after` is the
   * position of a message a reader was already sent, so an entry standing at it came later when `later` says so.
   */
  position: (entry: E) => number;
  /** Whether the entry came after the message standing at its own position (an answer done after it). */
  later?: (entry: E) => boolean;
  /** When the entry was said, in milliseconds since the epoch: what the retention is counted from. */
  time: (entry: E) => number;
  retentionMs?: number;
  now?: () => number;
}): ContextBuffer<E> {
  const { dir, label, isEntry, line, position, later, time } = options;
  const retentionMs = options.retentionMs ?? BUFFER_RETENTION_MS;
  const now = options.now ?? Date.now;
  const alive = (entry: E): boolean => time(entry) >= now() - retentionMs;

  const isPlace = (value: unknown): value is Place<E> => {
    const place = value as Place<E> | null;
    return (
      typeof place === "object" &&
      place !== null &&
      Array.isArray(place.entries) &&
      place.entries.every(isEntry) &&
      (place.expiredThrough === undefined || typeof place.expiredThrough === "number") &&
      (place.droppedAt === undefined || typeof place.droppedAt === "number")
    );
  };

  /**
   * The place with what is past the retention dropped, and a record of the newest position and the time it lost them;
   * undefined when nothing is. The place itself is not changed: it is replaced once the file is written, so a write that
   * failed is found due again at the next sweep.
   */
  const expired = (place: Place<E>): Place<E> | undefined => {
    const kept = place.entries.filter(alive);
    if (kept.length === place.entries.length) return undefined;
    const lost = place.entries.filter((entry) => !alive(entry)).map(position);
    return {
      entries: kept,
      expiredThrough: Math.max(place.expiredThrough ?? Number.NEGATIVE_INFINITY, ...lost),
      droppedAt: now(),
    };
  };
  /**
   * A place with nothing left and a note of what it lost that is itself a retention old: no reader needs it any more
   * (one that has not read a place in twice the retention is told, if at all, that it is new to it), so its file goes.
   */
  const forgotten = (place: Place<E>): boolean =>
    place.entries.length === 0 && place.droppedAt !== undefined && place.droppedAt < now() - retentionMs;

  const fileOf = (placeKey: string): string => join(dir, `${encodeURIComponent(placeKey)}.json`);
  const persist = (placeKey: string, place: Place<E>): void => {
    ensureStateHome(dir);
    saveStateFile(fileOf(placeKey), place);
  };

  const places = new Map<string, Place<E>>();
  /** Bring one place's file and record up to the retention: what expired dropped, or a place with nothing left gone. */
  const tidy = (key: string, place: Place<E>): void => {
    if (forgotten(place)) {
      rmSync(fileOf(key), { force: true });
      places.delete(key);
      return;
    }
    const tidied = expired(place);
    if (tidied === undefined) return;
    persist(key, tidied);
    places.set(key, tidied);
  };
  if (existsSync(dir)) {
    let unreadable = 0;
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
      const raw = loadStateFile(join(dir, file));
      if (!isPlace(raw)) {
        unreadable++;
        continue;
      }
      places.set(decodeURIComponent(file.slice(0, -".json".length)), raw);
    }
    // One place at a time: a file of an older shape costs its own place's buffer, not every place's.
    if (unreadable > 0) {
      log.warn(
        `${label} unexpected shape in ${unreadable} place(s) of ${dir} — those start with an empty context buffer`,
      );
    }
    for (const [key, place] of places) tidy(key, place);
  }
  let sweptAt = now();

  return {
    push(placeKey, entry) {
      const previous = places.get(placeKey);
      const grown: Place<E> = { ...previous, entries: [...(previous?.entries ?? []), entry] };
      const place = expired(grown) ?? grown;
      // A failed write throws before the place is replaced in memory: the throw becomes the webhook's 500 and the platform
      // redelivers, so an entry kept here would be appended a second time.
      persist(placeKey, place);
      places.set(placeKey, place);
      if (now() - sweptAt >= SWEEP_EVERY_MS) {
        sweptAt = now();
        // A quiet place keeps nothing past the retention on disk either. A failed rewrite is said and, the place being left
        // as it was, found due again at the next sweep: what it holds is never folded meanwhile, since the fold leaves
        // out what has expired.
        for (const [key, other] of [...places]) {
          if (key === placeKey) continue;
          try {
            tidy(key, other);
          } catch (error) {
            log.warn(`${label} could not tidy place ${key} of what has expired: ${String(error)}`);
          }
        }
      }
    },
    fold(placeKey, { after, until, budget, skip }) {
      const place = places.get(placeKey);
      const inRange = (place?.entries ?? []).filter(
        (entry) =>
          alive(entry) &&
          (after === undefined || position(entry) > after || (position(entry) === after && later?.(entry) === true)) &&
          position(entry) <= until &&
          skip?.(entry) !== true,
      );
      const { text, folded } = fitToBudget(inRange, line, budget, false);
      // What the retention dropped since the reader last read is not a quiet place: say so, ahead of what remains.
      const dropped = place?.expiredThrough !== undefined && (after === undefined || place.expiredThrough > after);
      const note = `(messages here older than ${Math.round(retentionMs / 86_400_000)} days are no longer kept)`;
      return { text: dropped ? [note, text].filter(Boolean).join("\n") : text, folded };
    },
  };
}
