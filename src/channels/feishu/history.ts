/**
 * A Feishu/Lark place's history, read from `im/v1/messages` when a turn runs (docs/design/place-history.md). What a
 * place remembers between turns, and what a read leaves out, is the kit's (`createPlaceHistory`); this is the read:
 * newest first up to the turn's own ask (`end_time` in seconds, then `(create_time, message_id)`), back to the cursor,
 * with senders named from the chat's members.
 */
import { log } from "../../log.ts";
import { capBufferedRefs } from "../kit/context-buffer.ts";
import {
  type PlaceDiscussion,
  type PlaceHistory,
  type PlaceListing,
  type PlaceMessage,
  type PlaceRead,
  createPlaceHistory,
} from "../kit/place-history.ts";
import { type ThreadSummary, threadList } from "../kit/room-threads.ts";
import { CONTEXT_READ } from "../kit/transport.ts";
import type { FeishuApi, FeishuListedMessage } from "./feishu-api.ts";
import { decodeFeishuContent } from "./normalize.ts";

/** How many of a place's newest messages one read lists; a place busier than this since its last answer says so. */
const PAGE_SIZE = 50;

/** What a place's first answered turn reads back, with no cursor yet. */
const FIRST_READ = 20;

/** How long a chat's member names are reused before they are read again. */
const NAMES_TTL_MS = 10 * 60_000;

/** A message's position: `create_time` alone is not unique, so the id breaks ties. */
interface FeishuCursor {
  at: number;
  id: string;
}

export type FeishuPlaceRead = PlaceRead<FeishuCursor>;
export type FeishuDiscussion = PlaceDiscussion<FeishuCursor>;
export interface FeishuPlaceHistory extends PlaceHistory<FeishuCursor> {
  /** The chat's threads among its newest messages, for a tool (`kit/room-threads.ts`). */
  threads(chatId: string): Promise<string>;
}

/** A background resource carried into a turn, with attribution for its prompt manifest. */
export interface FeishuBufferedRef {
  messageId: string;
  key: string;
  name?: string;
  from: string;
}

/** Someone said it: not deleted, and not the platform's own (a system message has no sender). */
function isSpoken(item: FeishuListedMessage): boolean {
  return item.deleted !== true && item.msg_type !== "system" && Boolean(item.sender?.sender_type);
}

/** A place: the chat, or a thread within it. The turn record carries it as this key. */
export function feishuHistoryKey(place: { chatId: string; threadId?: string }): string {
  return place.threadId ? `${place.chatId}:thread:${place.threadId}` : place.chatId;
}

/** The inverse of {@link feishuHistoryKey}. */
export function feishuPlaceOf(key: string): { chatId: string; threadId?: string } {
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

export function createFeishuPlaceHistory(deps: {
  api: Pick<FeishuApi, "listMessages" | "chatMemberNames">;
  /** THIS app's id: a message whose sender is this app is the agent's own. */
  appId: string;
  label: string;
  /** Where each place's cursor and outputs persist. */
  path: string;
  isTurnInput(messageId: string): boolean;
}): FeishuPlaceHistory {
  const { api, appId, label } = deps;
  /**
   * Per chat, the speakers already looked up: named, or known to have no name to find (not a member, past the page
   * cap, or a failed read). Both halves expire together, so a failure or a newcomer is retried after the TTL, not on
   * every turn.
   */
  const names = new Map<string, { named: Map<string, string>; unnamed: Set<string>; at: number }>();

  /** Names for the speakers a fold shows; one not found is shown by open_id. Never rejects: a name is a label. */
  const memberNames = async (chatId: string, speakers: ReadonlySet<string>): Promise<Map<string, string>> => {
    const cached = names.get(chatId);
    const entry =
      cached && Date.now() - cached.at < NAMES_TTL_MS
        ? cached
        : { named: new Map<string, string>(), unnamed: new Set<string>(), at: Date.now() };
    names.set(chatId, entry);
    const unknown = new Set([...speakers].filter((id) => !entry.named.has(id) && !entry.unnamed.has(id)));
    if (unknown.size === 0) return entry.named;
    try {
      const { names: found, complete } = await api.chatMemberNames(chatId, unknown, CONTEXT_READ);
      for (const [id, name] of found) entry.named.set(id, name);
      const missing = [...unknown].filter((id) => !found.has(id));
      for (const id of missing) entry.unnamed.add(id);
      // A complete list without them is ordinary (they left the chat); a list cut at the page cap is a gap to say.
      if (!complete && missing.length > 0) {
        log.warn(
          `${label} chat ${chatId} has more members than one name read covers; ${missing.length} speaker(s) are shown by open_id`,
        );
      }
    } catch (error) {
      for (const id of unknown) entry.unnamed.add(id);
      log.warn(`${label} could not read chat ${chatId}'s member names (speakers are shown by id): ${String(error)}`);
    }
    return entry.named;
  };

  /** One listed message as a fold shows it; `people` names the humans among its speakers. */
  const placeMessage = (
    item: FeishuListedMessage,
    id: string,
    at: number,
    people: ReadonlyMap<string, string>,
  ): PlaceMessage => {
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
          ? { kind: "self", label: "you" }
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
  };

  /** The place's messages since its cursor (or its newest {@link FIRST_READ}), oldest first, minus the session's own. */
  const read = async (
    key: string,
    { cursor, drop }: { cursor?: FeishuCursor; drop(messageId: string): boolean },
    until?: FeishuCursor,
  ): Promise<PlaceListing<FeishuCursor>> => {
    const place = feishuPlaceOf(key);
    const listed = await api.listMessages(
      place.threadId ? { type: "thread", id: place.threadId } : { type: "chat", id: place.chatId },
      PAGE_SIZE,
      // Seconds, inclusive: the same second's later messages still arrive, and are skipped below by time.
      until ? Math.floor(until.at / 1000) : undefined,
      CONTEXT_READ,
    );
    // A thread id names a thread in ANY chat the bot is in: its key's chat is a claim this read checks.
    const stranger = place.threadId ? listed.items.find((item) => item.chat_id !== place.chatId) : undefined;
    if (stranger) throw new Error(`thread ${place.threadId} is not in chat ${place.chatId}`);
    const fresh: { item: FeishuListedMessage; id: string; at: number }[] = [];
    let reachedCursor = false;
    for (const item of listed.items) {
      const id = item.message_id;
      const at = Number(item.create_time);
      if (!id || !Number.isFinite(at)) continue;
      if (until && (id === until.id || at > until.at)) continue;
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

    const covered = fresh.map(({ id }) => id);
    const kept = fresh.reverse().filter(({ item, id }) => {
      if (!isSpoken(item)) return false;
      // A topic group lists every topic's replies with its chat; the room is its top-level messages.
      if (!place.threadId && item.thread_id && item.root_id) return false;
      return !drop(id);
    });
    const speakers = new Set(
      kept.flatMap(({ item }) => (item.sender?.sender_type === "user" && item.sender.id ? [item.sender.id] : [])),
    );
    const people = speakers.size > 0 ? await memberNames(place.chatId, speakers) : new Map<string, string>();
    const messages = kept.map(({ item, id, at }) => placeMessage(item, id, at, people));
    return { covered, messages, ...(newest ? { newest } : {}), earlier };
  };

  /**
   * The chat's threads among its newest {@link PAGE_SIZE} messages. Feishu has no thread list: an ordinary group lists
   * each thread's root (no reply count, no last activity), a topic group every message with its thread's id.
   */
  const threads = async (chatId: string): Promise<string> => {
    const listed = await api.listMessages({ type: "chat", id: chatId }, PAGE_SIZE, undefined, CONTEXT_READ);
    // Newest first, so a thread's first entry is its newest message seen and its last the earliest.
    const byThread = new Map<string, { item: FeishuListedMessage; id: string; at: number }[]>();
    for (const item of listed.items) {
      const at = Number(item.create_time);
      if (!item.thread_id || !item.message_id || !isSpoken(item) || !Number.isFinite(at)) continue;
      byThread.set(item.thread_id, [...(byThread.get(item.thread_id) ?? []), { item, id: item.message_id, at }]);
    }
    const openers = [...byThread.values()].map((seen) => seen.at(-1) as (typeof seen)[number]);
    const speakers = new Set(
      openers.flatMap(({ item }) => (item.sender?.sender_type === "user" && item.sender.id ? [item.sender.id] : [])),
    );
    const people = speakers.size > 0 ? await memberNames(chatId, speakers) : new Map<string, string>();
    const summaries = [...byThread].map(([id, seen]): ThreadSummary => {
      const opener = seen.at(-1) as (typeof seen)[number];
      const message = placeMessage(opener.item, opener.id, opener.at, people);
      return {
        id,
        latestAt: (seen[0] as (typeof seen)[number]).at,
        first: { label: message.from.label, text: message.text },
      };
    });
    return threadList(summaries, `this chat's newest ${PAGE_SIZE} messages`);
  };

  const history = createPlaceHistory({
    label,
    path: deps.path,
    isCursor: (value): value is FeishuCursor =>
      typeof (value as FeishuCursor)?.at === "number" && typeof (value as FeishuCursor).id === "string",
    compare: (a, b) => a.at - b.at,
    isTurnInput: (_key, id) => deps.isTurnInput(id),
    read,
  });
  return { ...history, threads };
}
