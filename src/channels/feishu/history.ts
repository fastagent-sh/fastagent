/**
 * A Feishu or Lark place's history, read from `im/v1/messages` when the `history` tool asks: a chat's top level or a
 * thread in it, newest first, with senders named from the chat's members. Nothing is kept between reads.
 */
import { log } from "../../log.ts";
import { HISTORY_MAX_LIMIT, type PlaceMessage, type PlaceRead } from "../kit/history.ts";
import { CONTEXT_READ } from "../kit/ingress.ts";
import type { FeishuApi, FeishuListedMessage } from "./feishu-api.ts";
import { decodeFeishuContent } from "./normalize.ts";

/** How long a chat's member names are reused before they are read again. */
const NAMES_TTL_MS = 10 * 60_000;

/** Someone said it: not deleted, and not the platform's own (a system message has no sender). */
function isSpoken(item: FeishuListedMessage): boolean {
  return item.deleted !== true && item.msg_type !== "system" && Boolean(item.sender?.sender_type);
}

/** A place: the chat, or a thread within it. The turn record carries it as this key. */
export function feishuHistoryKey(place: { chatId: string; threadId?: string }): string {
  return place.threadId ? `${place.chatId}:thread:${place.threadId}` : place.chatId;
}

/** The inverse of {@link feishuHistoryKey}. */
function feishuPlaceOf(key: string): { chatId: string; threadId?: string } {
  const at = key.indexOf(":thread:");
  return at === -1 ? { chatId: key } : { chatId: key.slice(0, at), threadId: key.slice(at + ":thread:".length) };
}

export function createFeishuHistory(deps: {
  api: Pick<FeishuApi, "listMessages" | "chatMemberNames">;
  /** THIS app's id: a message whose sender is this app is the agent's own. */
  appId: string;
  label: string;
}): (place: string, query: { limit: number; threadId?: string }) => Promise<PlaceRead> {
  const { api, appId, label } = deps;
  /**
   * Per chat, the speakers already looked up: named, or known to have no name to find (not a member, past the page
   * cap, or a failed read). Both halves expire together, so a failure or a newcomer is retried after the TTL, not on
   * every turn.
   */
  const names = new Map<string, { named: Map<string, string>; unnamed: Set<string>; at: number }>();

  /** Names for the speakers a read shows; one not found is shown by open_id. Never rejects: a name is a label. */
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

  /** One listed message as the tool shows it; `people` names the humans among its speakers. */
  const placeMessage = (
    item: FeishuListedMessage,
    id: string,
    people: ReadonlyMap<string, string>,
    inChat: boolean,
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
    // In a chat's listing a thread's root carries the thread's id, and its replies their root's too.
    const opened = inChat && item.thread_id !== undefined && item.root_id === undefined;
    return {
      id,
      from,
      text: decoded.text,
      ...(item.parent_id ? { replyTo: item.parent_id } : {}),
      ...(opened ? { thread: { id: item.thread_id as string } } : {}),
    };
  };

  /** The place's newest `limit` messages, or those of a thread in its chat, oldest first. */
  return async (key, { limit, threadId }) => {
    const place = feishuPlaceOf(key);
    const thread = threadId ?? place.threadId;
    const listed = await api.listMessages(
      thread ? { type: "thread", id: thread } : { type: "chat", id: place.chatId },
      HISTORY_MAX_LIMIT,
    );
    // A thread id names a thread in ANY chat the bot is in: reading one of another chat would leak that chat here.
    const stranger = thread ? listed.items.find((item) => item.chat_id !== place.chatId) : undefined;
    if (stranger) throw new Error(`thread ${thread} is not in this chat`);
    const spoken = listed.items.filter(
      (item): item is FeishuListedMessage & { message_id: string } =>
        Boolean(item.message_id) &&
        isSpoken(item) &&
        // A topic group lists every topic's replies with its chat; the chat's place is its top-level messages.
        (thread !== undefined || !(item.thread_id && item.root_id)),
    );
    const newest = spoken.slice(0, limit).reverse();
    const speakers = new Set(
      newest.flatMap((item) => (item.sender?.sender_type === "user" && item.sender.id ? [item.sender.id] : [])),
    );
    const people = speakers.size > 0 ? await memberNames(place.chatId, speakers) : new Map<string, string>();
    return {
      messages: newest.map((item) => placeMessage(item, item.message_id, people, thread === undefined)),
      earlier: listed.hasMore || spoken.length > newest.length,
    };
  };
}
