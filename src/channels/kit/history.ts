/**
 * Channel conversation history, ask position log, group room thread lookup, and thread fork point lookup.
 */
import { type Agent, AgentError, type Message } from "../../agent-api.ts";
import type { ForkSource } from "../../channel.ts";
import { log } from "../../log.ts";
import { loadStateFile, saveStateFile } from "../../state-file.ts";
import { BUFFER_LINE_MAX_CHARS } from "./context-buffer.ts";
import { fitToBudget } from "./fold-budget.ts";
import { truncateCodePointPrefix } from "./text.ts";

/** The discussion a turn folds into its message: the text, and the messages behind it (whose attachments ride along). */
export interface Discussion<F> {
  text: string;
  folded: F[];
  /** The place could not be read (the text says so): the turn goes on, and what it missed is read again next time. */
  unread?: true;
}

export interface PlaceMessage {
  id: string;
  at: number;
  from: { kind: "human" | "self" | "bot"; label: string };
  text: string;
  replyTo?: string;
  images: { key: string }[];
  files: { key: string; name?: string }[];
}

const PLACE_OWN_MAX_CHARS = 2000;

function placeLine(message: PlaceMessage): string {
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

function foldPlace(
  messages: readonly PlaceMessage[],
  earlier: boolean,
  budget: number,
): { text: string; folded: PlaceMessage[] } {
  return fitToBudget(messages, placeLine, budget, earlier);
}

const MAX_PLACES = 2000;
const MAX_OUTPUTS = 200;

interface PlaceRead<C> {
  key: string;
  conversation: string;
  budget: number;
  after?: C;
  until?: C;
}

export interface PlaceListing {
  messages: PlaceMessage[];
  earlier: boolean;
}

export interface PlaceHistory<C> {
  fold(read: PlaceRead<C>): Promise<Discussion<PlaceMessage>>;
  recordOutput(key: string, conversation: string, messageId: string): void;
  snapshot(key: string): Promise<Discussion<PlaceMessage>>;
}

export function createPlaceHistory<C>(deps: {
  label: string;
  path: string;
  isControl?(key: string, messageId: string): boolean;
  read(key: string, from: { after?: C; drop(messageId: string): boolean }, until?: C): Promise<PlaceListing>;
  maxPlaces?: number;
}): PlaceHistory<C> {
  const { label, path, maxPlaces = MAX_PLACES } = deps;
  const places = loadOutputs(path, label);
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
      places.delete(at);
      places.set(at, outputs);
      for (const victim of [...places.keys()].slice(0, Math.max(0, places.size - maxPlaces))) places.delete(victim);
      try {
        saveStateFile(path, Object.fromEntries(places));
      } catch (error) {
        log.warn(
          `${label} could not write ${path} (after a restart this place's next read may fold the agent's own answer): ${String(error)}`,
        );
      }
    },
    async snapshot(key) {
      const { messages, earlier } = await deps.read(key, { drop: () => false });
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

const ASKS_PER_CONVERSATION = 6;
const MAX_CONVERSATIONS = 2000;

interface Ask<C> {
  key: string;
  at: C;
}

export interface AskLog<C> {
  record(conversation: string, ask: Ask<C>): void;
  forget(conversation: string, key: string): void;
  positionOf(conversation: string, key: string): C | undefined;
  readTo(conversation: string, sessionId: string | undefined, before?: C): Promise<C | undefined>;
}

function holdsItsAsk(message: Message): boolean {
  return message.entryId !== undefined || message.status === "queued" || message.status === "running";
}

export function createAskLog<C>(deps: {
  label: string;
  path: string;
  messages: Pick<Agent["messages"], "get">;
  isPosition(value: unknown): value is C;
  compare(a: C, b: C): number;
  maxConversations?: number;
}): AskLog<C> {
  const { label, path, messages, compare, maxConversations = MAX_CONVERSATIONS } = deps;
  const conversations = loadAsks(path, label, deps.isPosition);

  const save = (): void => {
    try {
      saveStateFile(path, Object.fromEntries(conversations));
    } catch (error) {
      log.warn(
        `${label} could not write ${path}: after a restart a conversation's next turn reads its place's newest messages ` +
          `instead of what came after its last ask: ${String(error)}`,
      );
    }
  };

  return {
    record(conversation, ask) {
      const kept = (conversations.get(conversation) ?? []).filter((other) => other.key !== ask.key);
      kept.push(ask);
      kept.sort((a, b) => compare(a.at, b.at));
      conversations.delete(conversation);
      conversations.set(conversation, kept.slice(-ASKS_PER_CONVERSATION));
      for (const victim of [...conversations.keys()].slice(0, Math.max(0, conversations.size - maxConversations))) {
        conversations.delete(victim);
      }
      save();
    },
    forget(conversation, key) {
      const kept = conversations.get(conversation);
      if (kept === undefined || !kept.some((ask) => ask.key === key)) return;
      conversations.set(
        conversation,
        kept.filter((ask) => ask.key !== key),
      );
      save();
    },
    positionOf: (conversation, key) => conversations.get(conversation)?.find((ask) => ask.key === key)?.at,
    async readTo(conversation, sessionId, before) {
      if (sessionId === undefined) return undefined;
      const earlier = (conversations.get(conversation) ?? []).filter(
        (ask) => before === undefined || compare(ask.at, before) < 0,
      );
      for (const ask of earlier.reverse()) {
        const message = await messages.get({ sessionId, idempotencyKey: ask.key }).catch((error: unknown) => {
          if (error instanceof AgentError && error.code === "not_found") return undefined;
          throw error;
        });
        if (message !== undefined && holdsItsAsk(message)) return ask.at;
      }
      return undefined;
    },
  };
}

export async function readStart<C>(
  asks: AskLog<C>,
  label: string,
  conversation: string,
  sessionId: string | undefined,
  before?: C,
): Promise<{ after?: C; unreadable?: string }> {
  try {
    const after = await asks.readTo(conversation, sessionId, before);
    return after === undefined ? {} : { after };
  } catch (error) {
    log.warn(
      `${label} could not tell where conversation ${conversation} read to; the turn reads the place's newest messages: ${String(error)}`,
    );
    return { unreadable: `(could not tell what was already read here, so some of this may repeat: ${String(error)})` };
  }
}

function loadAsks<C>(path: string, label: string, isPosition: (value: unknown) => value is C): Map<string, Ask<C>[]> {
  const raw = loadStateFile(path);
  if (raw === undefined) return new Map();
  const valid = (asks: unknown): asks is Ask<C>[] =>
    Array.isArray(asks) &&
    asks.every((ask) => typeof (ask as Ask<C>)?.key === "string" && isPosition((ask as Ask<C>).at));
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw) && Object.values(raw).every(valid)) {
    return new Map(Object.entries(raw as Record<string, Ask<C>[]>));
  }
  log.warn(`${label} unexpected shape in ${path} — every conversation reads its place's newest messages next`);
  return new Map();
}

export interface ThreadReader {
  list(room: string): Promise<string>;
  read(room: string, threadId: string): Promise<string>;
}

export interface RoomThreads {
  enter(sessionId: string, room: string): () => void;
  readonly reader: ThreadReader;
  roomOf(sessionId: string): string | undefined;
}

export function createRoomThreads(reader: ThreadReader): RoomThreads {
  const rooms = new Map<string, string>();
  return {
    enter(session, room) {
      rooms.set(session, room);
      return () => {
        if (rooms.get(session) === room) rooms.delete(session);
      };
    },
    reader,
    roomOf: (session) => rooms.get(session),
  };
}

const mounted = new Map<string, Map<string, RoomThreads>>();

export function registerRoomThreads(kind: string, stateDir: string, rooms: RoomThreads): void {
  const byChannel = mounted.get(kind) ?? new Map<string, RoomThreads>();
  byChannel.set(stateDir, rooms);
  mounted.set(kind, byChannel);
}

export function roomThreads(
  kind: string,
  sessionId: string | undefined,
): { list(): Promise<string>; read(threadId: string): Promise<string> } {
  const serving = [...(mounted.get(kind)?.values() ?? [])];
  if (serving.length === 0) {
    throw new Error(`no ${kind} channel is serving in this process: threads are read only in a chat turn`);
  }
  const rooms = sessionId === undefined ? undefined : serving.find((each) => each.roomOf(sessionId) !== undefined);
  const room = sessionId === undefined ? undefined : rooms?.roomOf(sessionId);
  if (rooms === undefined || room === undefined) {
    throw new Error(
      `this turn was not asked in a ${kind} group chat: threads are read only from the group a turn was asked in`,
    );
  }
  return { list: () => rooms.reader.list(room), read: (threadId) => rooms.reader.read(room, threadId) };
}

export interface ThreadSummary {
  id: string;
  time: { at: number; is: "last active" | "started" };
  replies?: number;
  first: { label: string; text: string };
}

const MAX_LIST_THREADS = 20;
const PREVIEW_CHARS = 160;

export function threadList(threads: readonly ThreadSummary[], scanned: string): string {
  if (threads.length === 0) return `No threads among ${scanned}.`;
  const shown = [...threads].sort((a, b) => b.time.at - a.time.at).slice(0, MAX_LIST_THREADS);
  const when = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const lines = shown.map((thread) => {
    const meta = [
      thread.replies === undefined ? undefined : `${thread.replies} repl${thread.replies === 1 ? "y" : "ies"}`,
      `${thread.time.is} ${when(thread.time.at)}`,
    ]
      .filter(Boolean)
      .join(", ");
    const text = truncateCodePointPrefix(thread.first.text.replace(/\s+/g, " ").trim(), PREVIEW_CHARS, "…");
    return `- thread ${thread.id} (${meta}): ${thread.first.label}: ${text}`;
  });
  const more = threads.length - shown.length;
  const startedOnly = shown.some((thread) => thread.time.is === "started");
  return [
    `Threads in this room, newest first by the time shown (among ${scanned}). Pass a thread's id to read it.`,
    ...(startedOnly ? ["A thread shown by when it started may have later replies this list cannot see: read it."] : []),
    ...lines,
    ...(more > 0 ? [`(${more} more not listed)`] : []),
  ].join("\n");
}

function forkPoint(message: Message): string | undefined {
  if (message.status === "queued") return undefined;
  return message.answer?.entryId ?? message.entryId;
}

export async function threadForkSource(agent: Agent, sessionId: string | undefined, ask: string): Promise<ForkSource> {
  if (sessionId === undefined) return undefined;
  const message = await agent.messages.get({ sessionId, idempotencyKey: ask }).catch((error: unknown) => {
    if (error instanceof AgentError && error.code === "not_found") return undefined;
    throw error;
  });
  if (message === undefined) return undefined;
  const entryId = forkPoint(message);
  return { sessionId, ...(entryId === undefined ? {} : { entryId }) };
}
