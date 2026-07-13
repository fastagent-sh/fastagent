/**
 * Canonical Feishu protocol parsing — PURE: event field extraction, message-content decoding, prompt
 * envelope, and summon/route policy. Lark compatibility events reuse these wire shapes. Feishu
 * messages carry their payload as a JSON-ENCODED STRING in `content`, shaped by `message_type`
 * (text / post / image / file / audio / media / …). {@link parseContent} is the single decoder: it
 * yields the readable text (mention placeholders restored), the vision image keys, and the downloadable
 * file refs — the envelope, the turn record, and the parent-message resolution all read through it.
 */
import type { FeishuCloudKind } from "./cloud.ts";

/** One entry of a message's `mentions` array: the platform's parsed @-mention (the `key` is the
 *  placeholder in the text content, e.g. `@_user_1`). */
export interface FeishuMention {
  key: string;
  id?: { open_id?: string; user_id?: string; union_id?: string };
  name?: string;
  [k: string]: unknown;
}

/** A received message (the `im.message.receive_v1` event's `message`, common subset; `[k]` keeps the
 *  rest reachable without a types dependency). */
export interface FeishuMessage {
  message_id: string;
  /** The replied-to message, when this message is a reply. Content is NOT included — the channel
   *  fetches it via the API (the IO half, invoke-turn.ts). */
  parent_id?: string;
  root_id?: string;
  chat_id: string;
  /** Present in topic groups — reply into the same topic to stay threaded. */
  thread_id?: string;
  chat_type: string; // "p2p" | "group"
  message_type: string; // "text" | "post" | "image" | "file" | "audio" | "media" | …
  /** JSON-encoded string, shaped by message_type — decode with {@link parseContent}. */
  content: string;
  mentions?: FeishuMention[];
  [k: string]: unknown;
}

export interface FeishuSender {
  sender_id?: { open_id?: string; user_id?: string; union_id?: string };
  /** "user" for humans; apps/bots have other values — the default route ignores those (anti-loop). */
  sender_type?: string;
  [k: string]: unknown;
}

/** The `im.message.receive_v1` event body (`event` of the v2.0 envelope). */
export interface FeishuMessageEvent {
  sender?: FeishuSender;
  message?: FeishuMessage;
  [k: string]: unknown;
}

/** What `route` returns: act with these (every field optional — omitted ones default from the message),
 *  or null to ignore. */
export interface FeishuRoute {
  /** Conversation identity (default: `chat` or `chat:thread`). */
  session?: string;
  /** Reply target chat (default: the message's chat). */
  chatId?: string;
  /** Base prompt (default: {@link feishuEnvelope}); the channel still appends attachments. */
  text?: string;
}

/** A downloadable attachment reference: the resource key inside its carrying message (the resource API
 *  addresses a file by message_id + key). */
export interface FeishuAttachmentRef {
  key: string;
  name?: string;
}

/** A message's decoded payload — see the module header. */
export interface ParsedFeishuContent {
  /** Readable text: the text/post body with mention placeholders restored to `@Name`; marker lines
   *  (`[image]`, `[file: …]`) for non-text payloads, so a media-only message is never blank. */
  text: string;
  /** Vision images: `image_key`s from an image message or a post's inline images. */
  imageKeys: string[];
  /** Files to download to disk (file / audio / media). */
  fileRefs: FeishuAttachmentRef[];
}

/** Restore the platform's mention placeholders (`@_user_1`) in a text body to readable `@Name`. */
function restoreMentions(text: string, mentions: FeishuMention[] | undefined): string {
  let out = text;
  for (const m of mentions ?? []) {
    if (!m.key) continue;
    out = out.split(m.key).join(`@${m.name ?? "user"}`);
  }
  return out;
}

/** One node of a post (rich text) paragraph — text/a/at/img/media/code_block and friends. */
interface PostNode {
  tag?: string;
  text?: string;
  href?: string;
  user_name?: string;
  user_id?: string;
  image_key?: string;
  file_key?: string;
  language?: string;
  [k: string]: unknown;
}

/**
 * Decode a message's `content` by its `message_type` — the single decoder (module header). Unknown or
 * malformed content degrades to a visible marker (`[sticker message]`), never a throw: the payload is
 * external input, and a message the agent cannot read should still say WHAT it couldn't read.
 */
export function parseContent(m: Pick<FeishuMessage, "message_type" | "content" | "mentions">): ParsedFeishuContent {
  let c: Record<string, unknown>;
  try {
    c = JSON.parse(m.content) as Record<string, unknown>;
    if (typeof c !== "object" || c === null) throw new Error("not an object");
  } catch {
    return { text: `[unreadable ${m.message_type} message]`, imageKeys: [], fileRefs: [] };
  }
  const imageKeys: string[] = [];
  const fileRefs: FeishuAttachmentRef[] = [];
  const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
  switch (m.message_type) {
    case "text":
      return { text: restoreMentions(str(c.text) ?? "", m.mentions), imageKeys, fileRefs };
    case "post": {
      // A post is paragraphs of typed nodes; renders as text lines with inline markers. Mentions in a
      // post are `at` NODES (user_name inline), not placeholders — no restore pass needed.
      const lines: string[] = [];
      const title = str(c.title);
      if (title) lines.push(title);
      const paragraphs = Array.isArray(c.content) ? (c.content as PostNode[][]) : [];
      for (const para of paragraphs) {
        if (!Array.isArray(para)) continue;
        const parts: string[] = [];
        for (const node of para) {
          if (typeof node !== "object" || node === null) continue;
          if (node.tag === "at") parts.push(`@${str(node.user_name) ?? str(node.user_id) ?? "user"}`);
          else if (node.tag === "a")
            parts.push(node.href ? `${str(node.text) ?? node.href} (${node.href})` : (str(node.text) ?? ""));
          else if (node.tag === "img") {
            if (str(node.image_key)) imageKeys.push(node.image_key as string);
            parts.push("[image]");
          } else if (node.tag === "media") {
            if (str(node.file_key))
              fileRefs.push({ key: node.file_key as string, name: str(node.file_name as string) });
            parts.push("[video]");
          } else if (node.tag === "code_block")
            parts.push(`\n\`\`\`${str(node.language)?.toLowerCase() ?? ""}\n${str(node.text) ?? ""}\n\`\`\`\n`);
          else if (str(node.text)) parts.push(node.text as string);
        }
        const line = parts.join("").trim();
        if (line) lines.push(line);
      }
      return { text: lines.join("\n"), imageKeys, fileRefs };
    }
    case "image": {
      if (str(c.image_key)) imageKeys.push(c.image_key as string);
      return { text: "[image]", imageKeys, fileRefs };
    }
    case "file": {
      const name = str(c.file_name);
      if (str(c.file_key)) fileRefs.push({ key: c.file_key as string, name });
      return { text: `[file: ${name ?? "file"}]`, imageKeys, fileRefs };
    }
    case "audio": {
      if (str(c.file_key)) fileRefs.push({ key: c.file_key as string, name: "voice-message" });
      return { text: "[voice message]", imageKeys, fileRefs };
    }
    case "media": {
      const name = str(c.file_name);
      if (str(c.file_key)) fileRefs.push({ key: c.file_key as string, name });
      return { text: `[video: ${name ?? "video"}]`, imageKeys, fileRefs };
    }
    case "location": {
      const name = str(c.name);
      return {
        text: `[location: ${name ? `${name} — ` : ""}${str(c.latitude) ?? "?"},${str(c.longitude) ?? "?"}]`,
        imageKeys,
        fileRefs,
      };
    }
    default:
      // sticker / share_chat / share_user / system / … — name the type so the agent can say what it got.
      return { text: `[${m.message_type} message]`, imageKeys, fileRefs };
  }
}

/** A stable sender label for attribution. The receive event carries only ids (a display name needs a
 *  contacts-API scope), so the label is the open_id — stable across turns, which is what a shared
 *  multi-user session needs to tell participants apart. */
export function senderLabel(sender: FeishuSender | undefined): string | undefined {
  const id = sender?.sender_id?.open_id ?? sender?.sender_id?.user_id ?? sender?.sender_id?.union_id;
  return id ? `user ${id}` : undefined;
}

/** The place a message lives (chat, or chat:topic in a topic group) — the default session key. */
export function placeKey(m: Pick<FeishuMessage, "chat_id" | "thread_id">): string {
  return m.thread_id ? `${m.chat_id}:${m.thread_id}` : m.chat_id;
}

/**
 * The default base prompt: a context envelope (chat/thread/sender + a group note + a reply marker),
 * then the message's decoded body. The sender is named on every message and a group chat is flagged —
 * in a shared multi-user session that is how the model tells participants apart and knows it is not a
 * 1:1. A reply carries only `[in reply to msg …]` here: the referent's CONTENT is not in the event, so
 * the channel fetches and appends it in the IO half (invoke-turn.ts), keeping this layer pure. Exported
 * so a custom Feishu `route` can reuse it, e.g. `text: `${feishuEnvelope(event)}\n\n[extra]``. The
 * internal compatibility seam binds the same shape to `[lark: …]`; each kind's send tool reads the
 * chat id from its own branded line.
 */
export function feishuEnvelope(event: FeishuMessageEvent): string {
  return cloudEnvelope(event, "feishu");
}

/** Internal compatibility seam: bind the canonical envelope shape to one cloud's branded tag. */
export function cloudEnvelope(event: FeishuMessageEvent, tag: FeishuCloudKind): string {
  const m = event.message;
  if (!m) return "";
  const meta = [
    `chat ${m.chat_id} (${m.chat_type})`,
    m.thread_id ? `topic ${m.thread_id}` : undefined,
    senderLabel(event.sender) ? `from ${senderLabel(event.sender)}` : undefined,
  ]
    .filter(Boolean)
    .join(", ");
  const scope =
    m.chat_type === "group" ? "\n[group chat — multiple people; each message is prefixed with its sender]" : "";
  const replyTo = m.parent_id ? `\n[in reply to msg ${m.parent_id}]` : "";
  return `[${tag}: ${meta}]${scope}${replyTo}\n${parseContent(m).text}`;
}

/**
 * Whether the message @mentions the bot — read from the `mentions` array the platform already parsed
 * (never a regex over the text: a pasted `@bot` in a code block is not a mention entry), matched on the
 * bot's open_id (stable identity; names are mutable). No id → fail closed (false): answering "is this
 * mention me?" with "I don't know who I am, so yes" would mis-summon in every multi-bot group.
 */
export function mentionsBot(m: Pick<FeishuMessage, "mentions">, botOpenId: string | undefined): boolean {
  if (!botOpenId) return false;
  return (m.mentions ?? []).some((x) => x.id?.open_id === botOpenId);
}

/**
 * The default routing policy (used when `route` is omitted; exported so a custom route can reuse it):
 * answer humans only (a non-`user` sender is another bot/app — two bots answering each other loop
 * forever), p2p chats always, a group only on an @mention of THIS bot (matched by open_id, which
 * feishuChannel resolves via bot/v3/info). NOTE the platform side of the same coin: with the default
 * `im:message.group_at_msg` scope, un-mentioned group messages are never even delivered — receiving
 * everything needs the sensitive `im:message.group_msg` scope. Returns `{}` (act; the channel fills
 * session/target/prompt from the message) or `null` (ignore).
 */
export function defaultFeishuRoute(event: FeishuMessageEvent, options?: { botOpenId?: string }): FeishuRoute | null {
  const m = event.message;
  if (!m) return null;
  if (event.sender?.sender_type !== "user") return null;
  const summoned = m.chat_type === "p2p" || mentionsBot(m, options?.botOpenId);
  return summoned ? {} : null;
}
