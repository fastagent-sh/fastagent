/**
 * What a thread-reading tool may reach: the threads of the room its turn was asked in, and nothing else
 * (docs/design/place-history.md, #374).
 *
 * The room is never an argument. A model can be asked to read any chat ("what did they say in the other group?"), and
 * the platform lets the bot read every chat it is in, so a room the tool were told would let one chat read another.
 * The channel names the room instead: while a group turn runs, it registers that turn's room under the turn's session,
 * and the tool, asking with its own session (`ctx.sessionManager`), gets that room or nothing. A turn holds its
 * session's lease, so one session has one running turn and one room.
 */
import { resolveStateRoot } from "../../paths.ts";
import { truncateCodePointPrefix } from "./text.ts";

/** A channel's reads of its rooms' threads. Each resolves to text for the model; a failed read rejects. */
export interface ThreadReader {
  /** The room's recent threads, newest first, each with its id. */
  list(room: string): Promise<string>;
  /** One thread of the room, as it reads now. Rejects for a thread that is not in this room. */
  read(room: string, threadId: string): Promise<string>;
}

/** The rooms of a channel's running group turns, by session, and how to read their threads. */
export interface RoomThreads {
  /** The turn of `session` runs in `room` until the returned function is called. */
  enter(session: string, room: string): () => void;
  readonly reader: ThreadReader;
  roomOf(session: string): string | undefined;
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

/** Per channel kind, per agent state root: the mounted channel's rooms. A remount replaces the entry. */
const mounted = new Map<string, Map<string, RoomThreads>>();

export function registerRoomThreads(kind: string, stateRoot: string, rooms: RoomThreads): void {
  const byRoot = mounted.get(kind) ?? new Map<string, RoomThreads>();
  byRoot.set(stateRoot, rooms);
  mounted.set(kind, byRoot);
}

/** The threads a tool's turn may read, for the channel `kind` serving the tool's agent (`ctx.cwd`). */
export function roomThreads(
  kind: string,
  ctx: { cwd: string; sessionManager?: { getSessionId(): string } },
): { list(): Promise<string>; read(threadId: string): Promise<string> } {
  const rooms = mounted.get(kind)?.get(resolveStateRoot(ctx.cwd));
  if (!rooms) {
    throw new Error(`no ${kind} channel is serving this agent in this process: threads are read only in a chat turn`);
  }
  const session = ctx.sessionManager?.getSessionId();
  const room = session === undefined ? undefined : rooms.roomOf(session);
  if (room === undefined) {
    throw new Error(
      `this turn was not asked in a ${kind} group chat: threads are read only from the group a turn was asked in`,
    );
  }
  return { list: () => rooms.reader.list(room), read: (threadId) => rooms.reader.read(room, threadId) };
}

/** One thread of a room, as a list shows it. */
export interface ThreadSummary {
  id: string;
  /** Milliseconds since the epoch: the newest message of the thread the read saw. */
  latestAt: number;
  /** When the platform says (Slack); Feishu's listing does not. */
  replies?: number;
  /** Its first message the read saw: the thread's opener, wherever the platform lists it. */
  first: { label: string; text: string };
}

/** Threads a list shows; a vague question reads every one listed, so the list is short. */
const MAX_THREADS = 20;
const PREVIEW_CHARS = 160;

/** The list a tool returns: newest first, each with the id that reads it, and what was left out said. */
export function threadList(threads: readonly ThreadSummary[], scanned: string): string {
  if (threads.length === 0) return `No threads among ${scanned}.`;
  const shown = [...threads].sort((a, b) => b.latestAt - a.latestAt).slice(0, MAX_THREADS);
  const when = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const lines = shown.map((thread) => {
    const meta = [
      thread.replies === undefined ? undefined : `${thread.replies} repl${thread.replies === 1 ? "y" : "ies"}`,
      `last active ${when(thread.latestAt)}`,
    ]
      .filter(Boolean)
      .join(", ");
    const text = truncateCodePointPrefix(thread.first.text.replace(/\s+/g, " ").trim(), PREVIEW_CHARS, "…");
    return `- thread ${thread.id} (${meta}): ${thread.first.label}: ${text}`;
  });
  const more = threads.length - shown.length;
  return [
    `Threads in this room, most recently active first (among ${scanned}). Pass a thread's id to read it.`,
    ...lines,
    ...(more > 0 ? [`(${more} more not listed)`] : []),
  ].join("\n");
}
