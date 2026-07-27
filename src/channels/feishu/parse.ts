/**
 * Canonical Feishu protocol policy and prompt-envelope helpers — PURE. Raw event types remain public
 * for the existing `route(event)` authoring surface; JSON-string content decoding is delegated to the
 * normalized-message boundary in normalize.ts so the turn engine and compatibility wrappers share one
 * decoder.
 */
import type { FeishuCloudKind } from "./cloud.ts";
import type { FeishuMention, FeishuMessage, FeishuMessageEvent, FeishuRoute, FeishuSender } from "./model.ts";
import { decodeFeishuContent } from "./normalize.ts";

export type { FeishuMention, FeishuMessage, FeishuMessageEvent, FeishuRoute, FeishuSender };

/** A resource reduced to what a caller needs to fetch and name it — the kind and carrying message id
 * that {@link decodeFeishuContent} attaches are supplied by the caller's own context. */
interface FeishuAttachmentRef {
  key: string;
  name?: string;
}

export interface ParsedFeishuContent {
  text: string;
  imageKeys: string[];
  fileRefs: FeishuAttachmentRef[];
}

/**
 * The decoder projected onto flat per-kind arrays, for callers that resolve a message on their own
 * (the prompt envelope, and the quoted parent whose resources are carried by the PARENT message id).
 * `decodeFeishuContent` stays canonical: this only reshapes what it returns.
 */
export function parseContent(
  message: Pick<FeishuMessage, "message_type" | "content" | "mentions">,
): ParsedFeishuContent {
  const decoded = decodeFeishuContent(message);
  return {
    text: decoded.text,
    imageKeys: decoded.resources.filter((resource) => resource.kind === "image").map((resource) => resource.key),
    fileRefs: decoded.resources
      .filter((resource) => resource.kind === "file" || resource.kind === "audio" || resource.kind === "video")
      .map((resource) => ({ key: resource.key, name: resource.name })),
  };
}

/** A stable sender label for attribution. Display names require an additional contacts permission. */
export function senderLabel(sender: FeishuSender | undefined): string | undefined {
  const id = senderId(sender);
  return id ? `user ${id}` : undefined;
}

/** Whichever id flavour the tenant populates. `sender_id` is a union and which members are filled is
 *  app configuration, not an invariant — callers only ever compare these for distinctness. */
export function senderId(sender: FeishuSender | undefined): string | undefined {
  return sender?.sender_id?.open_id ?? sender?.sender_id?.user_id ?? sender?.sender_id?.union_id;
}

/**
 * The place a message lives (the chat, or a thread within it) — the session key (participant model §5),
 * and the key thread participation is recorded under, since that record is a claim about this session.
 *
 * Branded with the channel kind, like Slack's twin, because session ids share ONE namespace across
 * every channel in a deployment: without it a `feishu` and a `lark` chat carrying the same platform id
 * would answer into the same memory. The length bound is the FILENAME the id becomes (sessions.ts
 * percent-encodes it, so each `:` costs three), and the worst case here — brand + a 35-char chat id +
 * a 36-char thread id — encodes to well under 100 bytes against the filesystem's 255.
 */
export function placeKey(kind: string, message: Pick<FeishuMessage, "chat_id" | "thread_id">): string {
  const chat = `${kind}:${message.chat_id}`;
  return message.thread_id ? `${chat}:${message.thread_id}` : chat;
}

/** The canonical Feishu-branded prompt envelope. */
export function feishuEnvelope(event: FeishuMessageEvent): string {
  return cloudEnvelope(event, "feishu");
}

/** Internal compatibility seam: bind the canonical envelope shape to one cloud's branded tag. */
export function cloudEnvelope(event: FeishuMessageEvent, tag: FeishuCloudKind): string {
  const message = event.message;
  if (!message) return "";
  const from = senderLabel(event.sender);
  const meta = [
    `chat ${message.chat_id} (${message.chat_type})`,
    message.thread_id ? `topic ${message.thread_id}` : undefined,
    from ? `from ${from}` : undefined,
  ]
    .filter(Boolean)
    .join(", ");
  const scope =
    message.chat_type === "group" ? "\n[group chat — multiple people; each message is prefixed with its sender]" : "";
  const replyTo = message.parent_id ? `\n[in reply to msg ${message.parent_id}]` : "";
  return `[${tag}: ${meta}]${scope}${replyTo}\n${parseContent(message).text}`;
}

/** Whether the parsed mention list contains this bot's app-scoped open_id. */
export function mentionsBot(message: Pick<FeishuMessage, "mentions">, botOpenId: string | undefined): boolean {
  if (!botOpenId) return false;
  return (message.mentions ?? []).some((mention) => mention.id?.open_id === botOpenId);
}

/**
 * Default EXPLICIT-summon policy: ignore non-user senders, always answer p2p, and answer groups only
 * when THIS bot is structurally mentioned. No bot identity means group routing fails closed. The
 * stateful channel wiring may additionally admit unmentioned messages in a thread it takes part in
 * (docs/design/participant-model.md §3).
 */
export function defaultFeishuRoute(event: FeishuMessageEvent, options?: { botOpenId?: string }): FeishuRoute | null {
  const message = event.message;
  if (!message) return null;
  if (event.sender?.sender_type !== "user") return null;
  const summoned = message.chat_type === "p2p" || mentionsBot(message, options?.botOpenId);
  return summoned ? {} : null;
}
