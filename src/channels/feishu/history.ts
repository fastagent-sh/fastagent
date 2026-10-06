/**
 * A Feishu/Lark place's history, read from the platform when a turn runs (docs/design/place-history.md): what was said
 * in a chat or a thread since this agent last answered there. It replaces the context buffer, which only ever held
 * what was pushed — never the agent's own posts, and never what was said before the channel started.
 *
 * What the session already holds is left out: the messages that were turns (`isTurnInput`: every ask, answered or
 * queued) and the messages this channel sent as turn output (`isTurnOutput`: answers, queue notices). What the agent
 * sent itself from a send tool stays — that is what a later "what did point 3 mean?" is about.
 */
import { log } from "../../log.ts";
import { capBufferedRefs } from "../kit/context-buffer.ts";
import { type DiscussionSource, type PlaceMessage, foldPlace } from "../kit/place-history.ts";
import { loadStateFile, saveStateFile } from "../kit/state.ts";
import type { FeishuApi, FeishuListedMessage } from "./feishu-api.ts";
import { decodeFeishuContent } from "./normalize.ts";

/** How many of a place's newest messages one read lists; a place busier than this since its last answer says so. */
const PAGE_SIZE = 50;

/** What a place's first answered turn reads back, with no cursor yet. */
const FIRST_READ = 20;

/** How long a chat's member names are reused before they are read again. */
const NAMES_TTL_MS = 10 * 60_000;

/** Places whose cursor is kept, oldest dropped: a dropped cursor costs one re-read of {@link FIRST_READ} messages. */
const MAX_CURSORS = 2000;

/** The newest message a committed turn's read reached: the next read starts after it. */
interface PlaceCursor {
  at: number;
  id: string;
}

/** One turn's read: where it reached, and what it folded (whose attachments ride along). */
export interface FeishuDiscussion {
  /** Absent when the read failed: the cursor then stays, and the next turn reads the same messages again. */
  cursor?: PlaceCursor;
  folded: PlaceMessage[];
}

/** A background resource carried into a turn, with attribution for its prompt manifest. */
export interface FeishuBufferedRef {
  messageId: string;
  key: string;
  name?: string;
  from: string;
}

/** A place: the chat, or a thread within it. The turn record carries it as this key. */
export function feishuHistoryKey(place: { chatId: string; threadId?: string }): string {
  return place.threadId ? `${place.chatId}:thread:${place.threadId}` : place.chatId;
}

function placeOf(key: string): { chatId: string; threadId?: string } {
  const at = key.indexOf(":thread:");
  return at === -1 ? { chatId: key } : { chatId: key.slice(0, at), threadId: key.slice(at + ":thread:".length) };
}

/** Select the most recent background resources of the folded messages, excluding the turn's own primary ones. */
export function collectFoldedAttachments(
  folded: readonly PlaceMessage[],
  primary: { files: { messageId: string; key: string }[]; images: { messageId: string; key: string }[] },
): { files: FeishuBufferedRef[]; images: FeishuBufferedRef[]; skipped: number } {
  const identity = (ref: { messageId: string; key: string }): string => `${ref.messageId}\u0000${ref.key}`;
  const refs = (
    pick: (message: PlaceMessage) => { key: string; name?: string }[],
    primaryRefs: { messageId: string; key: string }[],
  ): FeishuBufferedRef[] => {
    const seen = new Set(primaryRefs.map(identity));
    const out: FeishuBufferedRef[] = [];
    for (const message of folded) {
      for (const resource of pick(message)) {
        const ref = { messageId: message.id, ...resource, from: message.from.label };
        if (seen.has(identity(ref))) continue;
        seen.add(identity(ref));
        out.push(ref);
      }
    }
    return out;
  };
  const files = capBufferedRefs(refs((message) => message.files, primary.files));
  const images = capBufferedRefs(refs((message) => message.images, primary.images));
  return { files: files.kept, images: images.kept, skipped: files.skipped + images.skipped };
}

export interface FeishuPlaceHistory extends DiscussionSource<FeishuDiscussion> {
  /**
   * A thread's room, read-only, for the thread's first turn (participant-model §8): the room's own next answered turn
   * still reads it, so each place takes the discussion into its own memory.
   */
  room(key: string): Promise<{ text: string; folded: PlaceMessage[] }>;
}

export function createFeishuPlaceHistory(deps: {
  api: Pick<FeishuApi, "listMessages" | "chatMemberNames">;
  /** THIS app's id: a message whose sender is this app is the agent's own. */
  appId: string;
  label: string;
  /** Where the cursors persist. */
  path: string;
  isTurnInput(messageId: string): boolean;
  isTurnOutput(messageId: string): boolean;
}): FeishuPlaceHistory {
  const { api, appId, label, path } = deps;
  const cursors = loadCursors(path, label);
  const names = new Map<string, { names: Map<string, string>; at: number }>();
  const namesFailed = new Set<string>();

  const memberNames = async (chatId: string): Promise<Map<string, string>> => {
    const cached = names.get(chatId);
    if (cached && Date.now() - cached.at < NAMES_TTL_MS) return cached.names;
    try {
      const read = await api.chatMemberNames(chatId);
      names.set(chatId, { names: read, at: Date.now() });
      return read;
    } catch (error) {
      // Said once per chat: names are a label, so the discussion goes on by id.
      if (!namesFailed.has(chatId)) {
        namesFailed.add(chatId);
        log.warn(`${label} could not read chat ${chatId}'s member names (speakers are shown by id): ${String(error)}`);
      }
      return new Map();
    }
  };

  /** The place's messages since its cursor (or its newest {@link FIRST_READ}), oldest first, minus the session's own. */
  const read = async (key: string): Promise<{ messages: PlaceMessage[]; newest?: PlaceCursor; earlier: boolean }> => {
    const place = placeOf(key);
    const cursor = cursors.get(key);
    const listed = await api.listMessages(
      place.threadId ? { type: "thread", id: place.threadId } : { type: "chat", id: place.chatId },
      PAGE_SIZE,
    );
    const fresh: { item: FeishuListedMessage; id: string; at: number }[] = [];
    let reachedCursor = false;
    for (const item of listed.items) {
      const id = item.message_id;
      const at = Number(item.create_time);
      if (!id || !Number.isFinite(at)) continue;
      if (cursor && (id === cursor.id || at < cursor.at)) {
        reachedCursor = true;
        break;
      }
      fresh.push({ item, id, at });
      if (!cursor && fresh.length >= FIRST_READ) break;
    }
    const newest = fresh[0] ? { at: fresh[0].at, id: fresh[0].id } : undefined;
    const earlier = cursor
      ? !reachedCursor && (listed.hasMore || listed.items.length >= PAGE_SIZE)
      : fresh.length >= FIRST_READ && (listed.items.length > FIRST_READ || listed.hasMore);

    const kept = fresh.reverse().filter(({ item, id }) => {
      if (item.deleted === true || item.msg_type === "system" || !item.sender?.sender_type) return false;
      // A topic group lists every topic's replies with its chat; the room is its top-level messages.
      if (!place.threadId && item.thread_id && item.root_id) return false;
      return !deps.isTurnInput(id) && !deps.isTurnOutput(id);
    });
    const people = kept.some(({ item }) => item.sender?.sender_type === "user")
      ? await memberNames(place.chatId)
      : new Map<string, string>();
    const messages = kept.map(({ item, id, at }): PlaceMessage => {
      const decoded = decodeFeishuContent({
        message_type: item.msg_type ?? "unknown",
        content: item.body?.content ?? "",
        // The list API names a mention's id as a bare string; the decoder needs only key and name.
        mentions: item.mentions?.flatMap((mention) => (mention.key ? [{ key: mention.key, name: mention.name }] : [])),
      });
      const senderId = item.sender?.id ?? "unknown";
      const from: PlaceMessage["from"] =
        item.sender?.sender_type === "app"
          ? senderId === appId
            ? { kind: "self", label: "you (sent outside an answer, e.g. with a send tool)" }
            : { kind: "bot", label: `bot ${senderId}` }
          : { kind: "human", label: people.get(senderId) ?? `user ${senderId}` };
      return {
        id,
        at,
        from,
        text: decoded.text,
        ...(item.parent_id ? { replyTo: item.parent_id } : {}),
        images: decoded.resources.filter((r) => r.kind === "image").map((r) => ({ key: r.key })),
        files: decoded.resources
          .filter((r) => r.kind === "file" || r.kind === "audio" || r.kind === "video")
          .map((r) => ({ key: r.key, ...(r.name ? { name: r.name } : {}) })),
      };
    });
    return { messages, newest, earlier };
  };

  const unreadable = (key: string, error: unknown): { text: string; folded: PlaceMessage[] } => {
    log.warn(`${label} could not read the history of place ${key}; the turn runs without it: ${String(error)}`);
    return { text: `(could not read the recent discussion here: ${String(error)})`, folded: [] };
  };

  return {
    async peek(key) {
      try {
        const { messages, newest, earlier } = await read(key);
        const { text, folded } = foldPlace(messages, earlier);
        return { text, consumed: [{ ...(newest ? { cursor: newest } : {}), folded }] };
      } catch (error) {
        const { text } = unreadable(key, error);
        return { text, consumed: [{ folded: [] }] };
      }
    },
    commit(key, consumed) {
      const cursor = consumed[0]?.cursor;
      if (!cursor) return;
      cursors.delete(key); // re-inserted last: the map's order is the eviction order
      cursors.set(key, cursor);
      while (cursors.size > MAX_CURSORS) {
        const oldest = cursors.keys().next().value;
        if (oldest === undefined) break;
        cursors.delete(oldest);
      }
      try {
        saveStateFile(path, Object.fromEntries(cursors));
      } catch (error) {
        // Post-answer: the cursor holds in memory; a restart re-reads what this turn already folded.
        log.warn(
          `${label} place-history cursor write failed (a restart may re-fold answered discussion): ${String(error)}`,
        );
      }
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

function loadCursors(path: string, label: string): Map<string, PlaceCursor> {
  const raw = loadStateFile(path);
  if (raw === undefined) return new Map();
  const valid = (value: unknown): value is PlaceCursor =>
    typeof (value as PlaceCursor)?.at === "number" && typeof (value as PlaceCursor).id === "string";
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw) && Object.values(raw).every(valid)) {
    return new Map(Object.entries(raw as Record<string, PlaceCursor>));
  }
  log.warn(`${label} unexpected shape in ${path} — every place reads its recent history afresh`);
  return new Map();
}
