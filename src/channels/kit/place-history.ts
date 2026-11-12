/**
 * What a turn learns about its place (a chat, or a thread in one) beyond its own ask — and the fold that renders it,
 * shared by every channel whose platform can be read (docs/design/place-history.md).
 *
 * Two sources fill a turn's discussion: the context buffer (`context-buffer.ts`), for a platform with no history read,
 * and the place's own history, read from the platform when the turn runs ({@link createPlaceHistory}). Neither keeps a
 * record of what a turn read: the turn starts after the ask its session was last sent (`ask-log.ts`), so the session
 * is the one record of it.
 */
import { log } from "../../log.ts";
import { BUFFER_LINE_MAX_CHARS } from "./context-buffer.ts";
import { fitToBudget } from "./fold-budget.ts";
import { loadStateFile, saveStateFile } from "../../state-file.ts";
import { truncateCodePointPrefix } from "./text.ts";

/** The discussion a turn folds into its message: the text, and the messages behind it (whose attachments ride along). */
export interface Discussion<F> {
  text: string;
  folded: F[];
  /** The place could not be read (the text says so): the turn goes on, and what it missed is read again next time. */
  unread?: true;
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

/** Render `messages` (oldest first) into `budget` characters, newest first ({@link fitToBudget}). */
function foldPlace(
  messages: readonly PlaceMessage[],
  earlier: boolean,
  budget: number,
): { text: string; folded: PlaceMessage[] } {
  return fitToBudget(messages, line, budget, earlier);
}

/**
 * Places kept, least recently used dropped. A dropped place costs one re-read of its newest messages, its earlier
 * answers among them.
 */
const MAX_PLACES = 2000;

/**
 * A conversation's outputs in a place kept. One turn posts a handful (an answer, its chunks, stop feedback), and a read
 * only needs the ones after the ask its session was last sent; the bound stops one that posts without end from growing.
 */
const MAX_OUTPUTS = 200;

/**
 * What a turn reads: its place, after the ask its session was last sent (none: the place's newest messages), up to and
 * including its own ask, leaving out what its own conversation posted there. The upper bound is what keeps every later message out — an ask queued behind this one is its
 * own turn, and folding it here would answer it twice — and it needs no record of which messages were asks, so a lost
 * or cold state cannot break it. `C` is the platform's position of a message.
 */
export interface PlaceRead<C> {
  key: string;
  /** The conversation reading: what it posted is in its session, what other conversations posted is discussion. */
  conversation: string;
  /** The characters the read may fold ({@link foldBudget}): what the model's window lets one turn carry. */
  budget: number;
  after?: C;
  until?: C;
}

/** What a platform read of one place returns. */
export interface PlaceListing {
  /** What to fold, oldest first: system messages and what `drop` named already left out. */
  messages: PlaceMessage[];
  /** Older messages exist that the read never reached. */
  earlier: boolean;
}

export interface PlaceHistory<C> {
  /** The place's discussion for a turn. Never rejects: a place that cannot be read says so in `text`. */
  fold(read: PlaceRead<C>): Promise<Discussion<PlaceMessage>>;
  /**
   * A message a turn of `conversation` posted into this place: in its session already, so that conversation's next read
   * leaves it out. Another conversation's read keeps it: what the agent said to someone else is what that place said.
   */
  recordOutput(key: string, conversation: string, messageId: string): void;
  /**
   * A place as it reads now, for a tool: its newest messages, with nothing left out (another session's asks and
   * answers are what that place said). Rejects when the read fails: a tool's failure is the model's to see.
   */
  snapshot(key: string): Promise<Discussion<PlaceMessage>>;
}

/**
 * A place's history read from its platform (docs/design/place-history.md): what was said in a chat or a thread since
 * the ask its session was last sent, up to the turn's own ask. The platform owns the read; this owns the messages a
 * conversation's turns posted into the place (`recordOutput`: answers, stop feedback), which that conversation's read
 * leaves out because its session holds them. Everything else stays, other people's asks and the answers to them
 * among it: a session that did not take part is told what was said, attributed. What the agent sent itself from a send
 * tool stays too — that is what a later "what did point 3 mean?" is about.
 */
export function createPlaceHistory<C>(deps: {
  label: string;
  /** Where each place's outputs persist. */
  path: string;
  /** A message that is a control action (a `/stop`), not discussion: no read folds it. */
  isControl?(key: string, messageId: string): boolean;
  /** The place's messages after `after` (or its newest few, with none) and before `until`, oldest first. */
  read(key: string, from: { after?: C; drop(messageId: string): boolean }, until?: C): Promise<PlaceListing>;
  /** Places kept (default 2000). */
  maxPlaces?: number;
}): PlaceHistory<C> {
  const { label, path, maxPlaces = MAX_PLACES } = deps;
  const places = loadOutputs(path, label);
  /** One conversation's outputs in one place. */
  const scope = (key: string, conversation: string): string => `${conversation}\n${key}`;

  return {
    async fold({ key, conversation, budget, after, until }) {
      const outputs = new Set(places.get(scope(key, conversation)));
      try {
        const { messages, earlier } = await deps.read(
          key,
          {
            ...(after !== undefined ? { after } : {}),
            drop: (id) => outputs.has(id) || deps.isControl?.(key, id) === true,
          },
          until,
        );
        return foldPlace(messages, earlier, budget);
      } catch (error) {
        log.warn(`${label} could not read the history of place ${key}; the turn runs without it: ${String(error)}`);
        return { text: `(could not read the recent discussion here: ${String(error)})`, folded: [], unread: true };
      }
    },
    recordOutput(key, conversation, messageId) {
      const at = scope(key, conversation);
      const outputs = [...(places.get(at) ?? []), messageId].slice(-MAX_OUTPUTS);
      // Most recently used last: the map's order is the eviction order.
      places.delete(at);
      places.set(at, outputs);
      for (const victim of [...places.keys()].slice(0, Math.max(0, places.size - maxPlaces))) places.delete(victim);
      try {
        saveStateFile(path, Object.fromEntries(places));
      } catch (error) {
        // The caller is past a platform write (a sent message): throwing would report a send that happened as failed.
        // The state holds in memory; only a restart loses it.
        log.warn(
          `${label} could not write ${path} (after a restart this place's next read may fold the agent's own answer): ${String(error)}`,
        );
      }
    },
    async snapshot(key) {
      const { messages, earlier } = await deps.read(key, { drop: () => false });
      // A tool's read is the platform's page, which is bounded already: the model asked for all of it.
      return foldPlace(messages, earlier, Number.POSITIVE_INFINITY);
    },
  };
}

function loadOutputs(path: string, label: string): Map<string, string[]> {
  const raw = loadStateFile(path);
  if (raw === undefined) return new Map();
  const valid = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((id) => typeof id === "string");
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw) && Object.values(raw).every(valid)) {
    return new Map(Object.entries(raw as Record<string, string[]>));
  }
  log.warn(`${label} unexpected shape in ${path} — every place reads its recent history afresh`);
  return new Map();
}
