/**
 * What a turn learns about its place (a chat, or a thread in one) beyond its own ask — and the fold that renders it,
 * shared by every channel whose platform can be read (docs/design/place-history.md).
 *
 * Two sources fill a turn's discussion: the context buffer (`context-buffer.ts`), for a platform with no history read,
 * and the place's own history, read from the platform when the turn runs ({@link createPlaceHistory}). The turn
 * runner sees only {@link DiscussionSource}.
 */
import { log } from "../../log.ts";
import { BUFFER_LINE_MAX_CHARS, BUFFER_MAX_CHARS } from "./context-buffer.ts";
import { loadStateFile, saveStateFile } from "./state.ts";
import { truncateCodePointPrefix } from "./text.ts";

/**
 * Where a turn's discussion comes from. `peek` snapshots what this turn folds; `commit` runs when the turn's answer
 * is recorded, so a failure or crash before then leaves the discussion to be folded again. `P` names what is read: a
 * buffer bucket's key, or a place plus where this turn's read ends.
 */
export interface DiscussionSource<E, P = string> {
  /** Never rejects: a source that cannot read says so in `text`, and the turn proceeds without it. */
  peek(place: P): { text: string; consumed: E[] } | Promise<{ text: string; consumed: E[] }>;
  commit(place: P, consumed: E[]): void;
}

/** One message of a place, as the fold renders it. */
export interface PlaceMessage {
  id: string;
  /** Milliseconds since the epoch. */
  at: number;
  /** "self": this agent, outside its own turn answers (a schedule's digest, a post from another chat). */
  from: { kind: "human" | "self" | "bot"; label: string };
  text: string;
  replyTo?: string;
  images: { key: string }[];
  files: { key: string; name?: string }[];
}

/**
 * Per-message bound for the agent's own post. A digest runs to thousands of characters; the line bound would keep its
 * title only. It stays inside the budget, so later discussion still pushes it out.
 */
const PLACE_OWN_MAX_CHARS = 2000;

function line(message: PlaceMessage): string {
  const own = message.from.kind === "self";
  const body = truncateCodePointPrefix(
    message.text.replace(/\s+/g, " ").trim(),
    own ? PLACE_OWN_MAX_CHARS : BUFFER_LINE_MAX_CHARS,
    own ? " … (truncated)" : "…",
  );
  const meta = [`msg ${message.id}`, message.replyTo ? `reply to msg ${message.replyTo}` : undefined]
    .filter(Boolean)
    .join(", ");
  return `${message.from.label} (${meta}): ${body}`;
}

/**
 * Render `messages` (oldest first) newest-first into the buffer's budget (the same bound, whichever the source). What the budget leaves out, and what the read never
 * reached (`earlier`), is said in a line, never dropped silently.
 */
function foldPlace(messages: readonly PlaceMessage[], earlier: boolean): { text: string; folded: PlaceMessage[] } {
  const lines: string[] = [];
  const folded: PlaceMessage[] = [];
  let used = 0;
  let cut = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as PlaceMessage;
    const rendered = line(message);
    if (cut > 0 || used + rendered.length + 1 > BUFFER_MAX_CHARS) {
      cut++;
      continue;
    }
    used += rendered.length + 1;
    lines.unshift(rendered);
    folded.unshift(message);
  }
  if (cut > 0 || earlier) {
    lines.unshift(
      cut > 0
        ? `(${cut}${earlier ? "+" : ""} earlier message${cut === 1 && !earlier ? "" : "s"} here not shown)`
        : "(earlier messages here not shown)",
    );
  }
  return { text: folded.length > 0 || cut > 0 ? lines.join("\n") : "", folded };
}

/** Places kept, least recently used dropped: a dropped place costs one re-read of its newest messages. */
const MAX_PLACES = 2000;

/**
 * A place's outputs not yet passed by a read. One turn posts a handful (an answer, its chunks, a queue notice); the
 * bound only stops a place whose reads keep failing from growing without end.
 */
const MAX_OUTPUTS = 200;

/**
 * What a turn reads: its place, up to and including its own ask. The bound is what keeps every later message out —
 * an ask queued behind this one is its own turn, and folding it here would answer it twice — and it needs no record
 * of which messages were asks, so a lost or cold state cannot break it. `C` is the platform's position: the newest
 * message a read reached.
 */
export interface PlaceRead<C> {
  key: string;
  until: C;
}

/** One turn's read: where it reached, what it folded (whose attachments ride along), and which outputs it passed. */
export interface PlaceDiscussion<C> {
  /** Absent when the read failed: the cursor then stays, and the next turn reads the same messages again. */
  cursor?: C;
  folded: PlaceMessage[];
  outputsPassed: string[];
}

/** What a platform read of one place returns. */
export interface PlaceListing<C> {
  /** Every message id the read covered, kept or dropped: what tells which recorded outputs it passed. */
  covered: string[];
  /** What to fold, oldest first: system messages and what `drop` named already left out. */
  messages: PlaceMessage[];
  /** The newest message listed. A bounded read's cursor is its bound instead, the ask it read up to. */
  newest?: C;
  /** Older messages exist that the read never reached. */
  earlier: boolean;
}

export interface PlaceHistory<C> extends DiscussionSource<PlaceDiscussion<C>, PlaceRead<C>> {
  /** A message a turn posted into this place: in the session already, so the place's next read leaves it out. */
  recordOutput(key: string, messageId: string): void;
  /**
   * A thread's room, read-only, for the thread's first turn (participant-model §8): the room's own next answered turn
   * still reads it, so each place takes the discussion into its own memory.
   */
  room(key: string): Promise<{ text: string; folded: PlaceMessage[] }>;
}

/** What a place remembers between turns. */
interface PlaceState<C> {
  cursor?: C;
  /** Messages turns posted here that no read has passed yet. */
  outputs: string[];
}

/**
 * A place's history read from its platform (docs/design/place-history.md): what was said in a chat or a thread since
 * this agent last answered there, up to the turn's own ask. The platform owns the read; this owns what a place
 * remembers between turns — its cursor, and the messages turns posted there — and what a turn leaves out of its read:
 * the messages a turn posted into the place (`recordOutput`: answers, queue notices, stop feedback), kept beside the
 * cursor until a read has passed them, so a busy deployment cannot push a quiet place's last answer out of a shared
 * ring; and, as prompt shaping only, what the channel took as input (`isTurnInput`). What the agent sent itself from a
 * send tool stays — that is what a later "what did point 3 mean?" is about.
 */
export function createPlaceHistory<C>(deps: {
  label: string;
  /** Where each place's cursor and outputs persist. */
  path: string;
  isCursor(value: unknown): value is C;
  /** Negative, zero or positive as `a` is before, at or after `b`. */
  compare(a: C, b: C): number;
  isTurnInput(key: string, messageId: string): boolean;
  /** The place's messages after `cursor` (or its newest few, with none) and before `until`, oldest first. */
  read(key: string, from: { cursor?: C; drop(messageId: string): boolean }, until?: C): Promise<PlaceListing<C>>;
}): PlaceHistory<C> {
  const { label, path } = deps;
  const places = loadPlaces(path, label, deps.isCursor);
  /** Mark `key` most recently used (the map's order is the eviction order) and persist every place. */
  const save = (key: string, state: PlaceState<C>, lost: string): void => {
    places.delete(key);
    places.set(key, state);
    while (places.size > MAX_PLACES) {
      const oldest = places.keys().next().value;
      if (oldest === undefined) break;
      places.delete(oldest);
    }
    try {
      saveStateFile(path, Object.fromEntries(places));
    } catch (error) {
      // Both callers are past a platform write (a sent message, a recorded answer): throwing would report a send that
      // happened as failed. The state holds in memory; only a restart loses it.
      log.warn(`${label} could not write ${path} (${lost}): ${String(error)}`);
    }
  };

  const read = async (key: string, until?: C) => {
    const state = places.get(key);
    const outputs = new Set(state?.outputs);
    const listing = await deps.read(
      key,
      {
        ...(state?.cursor !== undefined ? { cursor: state.cursor } : {}),
        drop: (id) => outputs.has(id) || deps.isTurnInput(key, id),
      },
      until,
    );
    return {
      ...listing,
      // A bounded read has accounted for everything up to its bound, the ask included: the next read starts after it.
      newest: until ?? listing.newest,
      outputsPassed: listing.covered.filter((id) => outputs.has(id)),
    };
  };

  const unreadable = (key: string, error: unknown): { text: string; folded: PlaceMessage[] } => {
    log.warn(`${label} could not read the history of place ${key}; the turn runs without it: ${String(error)}`);
    return { text: `(could not read the recent discussion here: ${String(error)})`, folded: [] };
  };

  return {
    async peek({ key, until }) {
      try {
        const { messages, newest, earlier, outputsPassed } = await read(key, until);
        const { text, folded } = foldPlace(messages, earlier);
        return { text, consumed: [{ ...(newest !== undefined ? { cursor: newest } : {}), folded, outputsPassed }] };
      } catch (error) {
        const { text } = unreadable(key, error);
        return { text, consumed: [{ folded: [], outputsPassed: [] }] };
      }
    },
    commit({ key }, consumed) {
      const done = consumed[0];
      if (done?.cursor === undefined) return;
      // Only the outputs this read passed: the turn's own answer came after it and waits for the next read.
      const passed = new Set(done.outputsPassed);
      const state = places.get(key);
      const outputs = (state?.outputs ?? []).filter((id) => !passed.has(id));
      // Forward only. Turns in a place can finish out of ask order (a redelivered ask, a deferred turn); an earlier
      // ask committing after a later one must not pull the cursor back over what that later turn already folded.
      const cursor =
        state?.cursor !== undefined && deps.compare(state.cursor, done.cursor) >= 0 ? state.cursor : done.cursor;
      save(key, { cursor, outputs }, "a restart may re-fold answered discussion");
    },
    recordOutput(key, messageId) {
      const state = places.get(key);
      const outputs = [...(state?.outputs ?? []), messageId].slice(-MAX_OUTPUTS);
      save(
        key,
        { ...(state?.cursor !== undefined ? { cursor: state.cursor } : {}), outputs },
        "after a restart this place's next read may fold the agent's own answer",
      );
    },
    async room(key) {
      try {
        const { messages, earlier } = await read(key);
        return foldPlace(messages, earlier);
      } catch (error) {
        return unreadable(key, error);
      }
    },
  };
}

function loadPlaces<C>(
  path: string,
  label: string,
  isCursor: (value: unknown) => value is C,
): Map<string, PlaceState<C>> {
  const raw = loadStateFile(path);
  if (raw === undefined) return new Map();
  const valid = (value: unknown): value is PlaceState<C> => {
    const state = value as PlaceState<C>;
    return (
      typeof state === "object" &&
      state !== null &&
      (state.cursor === undefined || isCursor(state.cursor)) &&
      Array.isArray(state.outputs) &&
      state.outputs.every((id) => typeof id === "string")
    );
  };
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw) && Object.values(raw).every(valid)) {
    return new Map(Object.entries(raw as Record<string, PlaceState<C>>));
  }
  log.warn(`${label} unexpected shape in ${path} — every place reads its recent history afresh`);
  return new Map();
}
