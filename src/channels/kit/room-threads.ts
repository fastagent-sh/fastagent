/**
 * What a thread-reading tool may reach: the threads of the room its turn was asked in, and nothing else
 * (docs/design/place-history.md, #374).
 *
 * The room is never an argument. A model can be asked to read any chat ("what did they say in the other group?"), and
 * the platform lets the bot read every chat it is in, so a room the tool were told would let one chat read another.
 * The channel names the room instead: while a group turn runs, it registers that turn's room under the turn's session,
 * and the tool, asking with its own session (`sessionIdOf`), gets that room or nothing. A place's turns run one at a
 * time, so one session has one running turn and one room.
 */
import { truncateCodePointPrefix } from "./text.ts";

/** A channel's reads of its rooms' threads. Each resolves to text for the model; a failed read rejects. */
export interface ThreadReader {
  /** The room's recent threads, newest first, each with its id. */
  list(room: string): Promise<string>;
  /** One thread of the room, as it reads now. Rejects for a thread that is not in this room. */
  read(room: string, threadId: string): Promise<string>;
}

/** The rooms of a channel's running group turns, by session id, and how to read their threads. */
export interface RoomThreads {
  /** The turn of `sessionId` runs in `room` until the returned function is called. */
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

/**
 * Per channel kind, per mounted channel (its `stateDir`): that channel's rooms. A remount of the channel replaces its
 * entry, and two channel files of one kind keep one each. A session id names its storage, and a room is entered by the
 * turn that runs in it, so a tool's session finds its own channel among every one of its kind in the process.
 */
const mounted = new Map<string, Map<string, RoomThreads>>();

export function registerRoomThreads(kind: string, stateDir: string, rooms: RoomThreads): void {
  const byChannel = mounted.get(kind) ?? new Map<string, RoomThreads>();
  byChannel.set(stateDir, rooms);
  mounted.set(kind, byChannel);
}

/** The threads the turn running in `sessionId` may read, from the `kind` channel it was asked through. */
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

/** One thread of a room, as a list shows it. */
export interface ThreadSummary {
  id: string;
  /**
   * The one time a list can vouch for, in milliseconds since the epoch: its newest message, or only when it started
   * where its replies are not visible (a Feishu ordinary group lists a thread's root only).
   */
  time: { at: number; is: "last active" | "started" };
  /** When the platform says (Slack); Feishu's listing does not. */
  replies?: number;
  /** Its first message the read saw: the thread's opener, wherever the platform lists it. */
  first: { label: string; text: string };
}

/** Threads a list shows; a vague question reads every one listed, so the list is short. */
const MAX_THREADS = 20;
const PREVIEW_CHARS = 160;

/**
 * The list a tool returns: newest first by the time each line shows, each with the id that reads it, and what was
 * left out said. A thread shown by when it started may have gone on since, and the list says so, since whether a
 * problem was resolved is what a reader most often wants to know.
 */
export function threadList(threads: readonly ThreadSummary[], scanned: string): string {
  if (threads.length === 0) return `No threads among ${scanned}.`;
  const shown = [...threads].sort((a, b) => b.time.at - a.time.at).slice(0, MAX_THREADS);
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
