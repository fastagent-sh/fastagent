/** Telegram protocol parsing — PURE: message field extraction, the prompt envelope, and the summon/route policy. */
import { BUFFER_LINE_MAX_CHARS } from "../kit/context-buffer.ts";
import { REFERENT_MAX_CODE_POINTS, truncateCodePointPrefix } from "../kit/text.ts";

/** A Telegram message (the common subset; `[k]` keeps the rest reachable without a types dependency). */
export interface TelegramMessage {
  message_id: number;
  text?: string;
  /** Entities Telegram's server parsed out of `text` (mentions, commands, URLs, code…). */
  entities?: { type: string; offset: number; length: number; [k: string]: unknown }[];
  /** Caption on a media message (photo/document/…) — often the user's instruction for the attachment. */
  caption?: string;
  /** Entities of `caption`, same shape as {@link TelegramMessage.entities}. */
  caption_entities?: { type: string; offset: number; length: number; [k: string]: unknown }[];
  /** Photo sizes, smallest → largest. */
  photo?: { file_id: string; file_unique_id: string; width: number; height: number; file_size?: number }[];
  /** Structured payloads worth rendering into the prompt as text (no new modality needed). */
  location?: { latitude: number; longitude: number; [k: string]: unknown };
  contact?: { phone_number?: string; first_name: string; last_name?: string; [k: string]: unknown };
  poll?: { question: string; options?: { text: string }[]; [k: string]: unknown };
  /** Files — the channel downloads document/voice/video/audio on a routed message to disk. */
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number; [k: string]: unknown };
  voice?: { file_id: string; [k: string]: unknown };
  video?: { file_id: string; [k: string]: unknown };
  audio?: { file_id: string; [k: string]: unknown };
  /** Present in Threaded Mode (topics in private chats); reply with the same id to stay in-thread. */
  message_thread_id?: number;
  /** The message this one replies to, if any — inject its text/media so the agent has the referent. */
  reply_to_message?: TelegramMessage;
  chat: { id: number; type: string; [k: string]: unknown };
  from?: { id: number; username?: string; is_bot?: boolean; first_name?: string; [k: string]: unknown };
  [k: string]: unknown;
}

/**
 * A Telegram update (the common subset the channel ACTS on — an update kind not listed here is ACKed and dropped
 * before `route` sees it, so listing it would be a false promise; `[k]` keeps the raw payload reachable).
 */
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  channel_post?: TelegramMessage;
  [k: string]: unknown;
}

/**
 * What `route` returns: act with these (every field optional — omitted ones default from the message), or null to
 * ignore.
 */
export interface TelegramRoute {
  /** Conversation identity (default: `chat` or `chat:thread`). */
  session?: string;
  /** Reply target chat (default: the message's chat). */
  chatId?: number | string;
  /** Reply thread (default: the message's thread). */
  threadId?: number;
  /** Base prompt (default: {@link telegramEnvelope}); the channel still appends attachments + the HTML hint. */
  text?: string;
}

/** The actionable message in an update (a fresh message or channel post). */
export function pickMessage(update: TelegramUpdate): TelegramMessage | undefined {
  return update.message ?? update.channel_post;
}

/** file_ids to send the model as vision images: this message's largest photo + a replied-to photo. */
export function extractImages(m: TelegramMessage): string[] {
  return [...ownImages(m), ...(m.reply_to_message ? ownImages(m.reply_to_message) : [])];
}

/** The message's OWN photo (largest size), without the replied-to message's. */
export function ownImages(m: TelegramMessage): string[] {
  return [m.photo?.at(-1)?.file_id].filter((id): id is string => Boolean(id));
}

/** file_ids to download to disk: this message's files plus a replied-to message's ("summarize this file"). */
export function extractFiles(m: TelegramMessage): string[] {
  return [...ownFiles(m), ...(m.reply_to_message ? ownFiles(m.reply_to_message) : [])];
}

/** The message's OWN files, without the replied-to message's. */
export function ownFiles(m: TelegramMessage): string[] {
  return [m.document?.file_id, m.voice?.file_id, m.video?.file_id, m.audio?.file_id].filter((id): id is string =>
    Boolean(id),
  );
}

/** A stable sender label for attribution. */
export function fromLabel(from: TelegramMessage["from"]): string | undefined {
  if (!from) return undefined;
  return from.username ? `@${from.username}` : `${from.first_name ?? "user"} (id ${from.id})`;
}

/**
 * A one-line description of a message's attachment, so the envelope names what was sent even before the agent opens it
 * (and so a media-only message isn't blank).
 */
export function attachmentSummary(m: TelegramMessage): string | undefined {
  if (m.photo?.length) return "[photo]";
  if (m.document) {
    return `[document: ${m.document.file_name ?? "file"}${m.document.mime_type ? ` (${m.document.mime_type})` : ""}]`;
  }
  if (m.voice) return "[voice message]";
  if (m.video) return "[video]";
  if (m.audio) return "[audio]";
  return undefined;
}

/**
 * A message's readable body: its text, else its caption, else a one-line attachment summary; undefined for an
 * empty/service message.
 */
function bodyOf(m: TelegramMessage): string | undefined {
  return m.text ?? m.caption ?? attachmentSummary(m);
}

/** A one-line, length-capped rendering of a message's content for the context buffer. */
export function messageText(m: TelegramMessage): string {
  return truncateCodePointPrefix((bodyOf(m) ?? "").replace(/\s+/g, " ").trim(), BUFFER_LINE_MAX_CHARS);
}

/**
 * The default base prompt: a context envelope (chat/thread/sender + a group note + reply) then the user's text/caption
 * and a compact rendering of structured payloads (location/contact/poll).
 */
export function telegramEnvelope(m: TelegramMessage): string {
  const r = m.reply_to_message;
  const meta = [
    `chat ${m.chat.id} (${m.chat.type})`,
    m.message_thread_id ? `thread ${m.message_thread_id}` : undefined,
    fromLabel(m.from) ? `from ${fromLabel(m.from)}` : undefined,
  ]
    .filter(Boolean)
    .join(", ");
  // In a shared group session the model sees turns from different people (each `from`-tagged).
  const isGroup = m.chat.type === "group" || m.chat.type === "supergroup";
  const scope = isGroup ? "\n[group chat — multiple people; each message is prefixed with its sender]" : "";
  const replyTo = r
    ? `\n[in reply to ${fromLabel(r.from) ?? `msg ${r.message_id}`} (msg ${r.message_id}): ${truncateCodePointPrefix(bodyOf(r) ?? "(empty)", REFERENT_MAX_CODE_POINTS)}]`
    : "";
  const parts = [bodyOf(m) ?? ""];
  if (m.location) parts.push(`[location: ${m.location.latitude},${m.location.longitude}]`);
  if (m.contact) parts.push(`[contact: ${m.contact.first_name} ${m.contact.phone_number ?? ""}]`);
  if (m.poll) parts.push(`[poll: ${m.poll.question} — ${(m.poll.options ?? []).map((o) => o.text).join(" / ")}]`);
  return `[telegram: ${meta}]${scope}${replyTo}\n${parts.filter(Boolean).join("\n")}`;
}

/** Normalize a configured bot username: drop a leading `@`, trim, lowercase (usernames are case-insensitive). */
function botName(botUsername: string | undefined): string | undefined {
  const s = botUsername?.replace(/^@/, "").trim().toLowerCase();
  return s || undefined;
}

/**
 * The `mention` ENTITIES naming THIS bot — read from what Telegram's server already parsed, not a regex over the raw
 * text.
 */
function botMentions(m: TelegramMessage, botUsername: string | undefined): { offset: number; length: number }[] {
  const name = botName(botUsername);
  if (!name) return [];
  const text = m.text ?? m.caption ?? "";
  const entities = (m.text !== undefined ? m.entities : m.caption_entities) ?? [];
  return entities.filter(
    (e) => e.type === "mention" && text.slice(e.offset, e.offset + e.length).toLowerCase() === `@${name}`,
  );
}

function mentionsBot(m: TelegramMessage, botUsername: string | undefined): boolean {
  return botMentions(m, botUsername).length > 0;
}

/** The message text with THIS bot's mentions cut out, so a command addressed to it reads as the bare command. */
function textWithoutBotMentions(m: TelegramMessage, botUsername: string | undefined): string {
  const text = m.text ?? m.caption ?? "";
  return botMentions(m, botUsername)
    .sort((a, b) => b.offset - a.offset)
    .reduce((out, e) => out.slice(0, e.offset) + out.slice(e.offset + e.length), text)
    .trim();
}

/**
 * Whether the update is a `/stop` ADDRESSED TO THIS BOT — the one question the channel asks about a stop, because an
 * unaddressed one is not a command it may act on.
 */
export function telegramStop(update: TelegramUpdate, options?: { botUsername?: string; botId?: number }): boolean {
  const m = pickMessage(update);
  if (!m) return false;
  // This bot's own mentions are cut out before matching: `@thisbot /stop` is the same command as `/stop@thisbot`.
  const match = /^\/stop(?:@([A-Za-z0-9_]+))?$/i.exec(textWithoutBotMentions(m, options?.botUsername));
  if (!match) return false;
  // `/stop@name` states its addressee: ours only when the name is ours, and never when this bot does not know its own
  // username (fail closed — the same rule reply/mention summon follows).
  if (match[1] !== undefined) return match[1].toLowerCase() === botName(options?.botUsername);
  return m.chat.type === "private" || mentionsBot(m, options?.botUsername) || repliesToBot(m, options);
}

/**
 * Whether the message replies to THIS bot — not just any bot: in a multi-bot group, replying to another bot must not
 * summon ours.
 */
function repliesToBot(m: TelegramMessage, options?: { botUsername?: string; botId?: number }): boolean {
  const r = m.reply_to_message?.from;
  if (r?.is_bot !== true) return false;
  if (options?.botId !== undefined) return r.id === options.botId;
  const name = botName(options?.botUsername);
  return name !== undefined && r.username?.toLowerCase() === name;
}

/** The default routing policy (used when `route` is omitted; exported so a custom route can reuse it). */
export function defaultTelegramRoute(
  update: TelegramUpdate,
  options?: { botUsername?: string; botId?: number },
): TelegramRoute | null {
  const m = pickMessage(update);
  if (!m) return null;
  const summoned =
    m.chat.type === "private" ||
    repliesToBot(m, options) ||
    mentionsBot(m, options?.botUsername) ||
    // Adds exactly ONE case to the three above: the `/stop@thisbot` suffix form.
    telegramStop(update, options);
  return summoned ? {} : null;
}
