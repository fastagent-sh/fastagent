/**
 * Telegram protocol parsing — PURE: message field extraction, the prompt envelope, and the summon/route
 * policy. The defining invariant is purity: no state, no IO, no Bot API calls — plain data-in → data-out.
 * In telegram.ts's pipeline (verify → decide via `route` → run the turn → stream reply), this is the
 * "decide" and prompt-building half; telegram.ts wires it in and owns the stateful lifecycle. Kept
 * separate so this layer tests as plain functions and reads without the factory's noise.
 */

/** A Telegram message (the common subset; `[k]` keeps the rest reachable without a types dependency). */
export interface TelegramMessage {
  message_id: number;
  text?: string;
  /** Entities Telegram's server parsed out of `text` (mentions, commands, URLs, code…). Offsets are
   *  UTF-16 code units — exactly JS string indexing, so `text.slice(offset, offset + length)` is the
   *  entity's text verbatim. */
  entities?: { type: string; offset: number; length: number; [k: string]: unknown }[];
  /** Caption on a media message (photo/document/…) — often the user's instruction for the attachment. */
  caption?: string;
  /** Entities of `caption`, same shape as {@link TelegramMessage.entities}. */
  caption_entities?: { type: string; offset: number; length: number; [k: string]: unknown }[];
  /** Photo sizes, smallest → largest. The channel sends the largest to the model as a vision image. */
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

/** A Telegram update (the common subset the channel ACTS on — an update kind not listed here is ACKed
 *  and dropped before `route` sees it, so listing it would be a false promise; `[k]` keeps the raw
 *  payload reachable). Narrow for what you route on, e.g. `update.message?.text`. */
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  channel_post?: TelegramMessage;
  [k: string]: unknown;
}

/** What `route` returns: act with these (every field optional — omitted ones default from the message), or null to ignore. */
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

/** The actionable message in an update (a fresh message or channel post). Edits (`edited_message` /
 *  `edited_channel_post`) are deliberately NOT actionable: answering them re-answers every typo fix (a
 *  duplicate reply per edit), so an edited message changes nothing — the standard bot behavior. The
 *  trade-off: editing a mention INTO an old message does not summon either; send a new message. */
export function pickMessage(update: TelegramUpdate): TelegramMessage | undefined {
  return update.message ?? update.channel_post;
}

/** file_ids to send the model as vision images: this message's largest photo + a replied-to photo. */
export function extractImages(m: TelegramMessage): string[] {
  return [...ownImages(m), ...(m.reply_to_message ? ownImages(m.reply_to_message) : [])];
}

/** The message's OWN photo (largest size), without the replied-to message's — the buffer path uses
 *  this: each message is its own entry there, so counting the replied-to attachment again would
 *  duplicate it and squeeze the attachment cap (the reply relation is expressed by `replyTo` instead). */
export function ownImages(m: TelegramMessage): string[] {
  return [m.photo?.at(-1)?.file_id].filter((id): id is string => Boolean(id));
}

/** file_ids to download to disk for the agent's tools: this message's files + a replied-to message's
 *  (so "summarize this file" works when the user replies to a document with the mention). */
export function extractFiles(m: TelegramMessage): string[] {
  return [...ownFiles(m), ...(m.reply_to_message ? ownFiles(m.reply_to_message) : [])];
}

/** The message's OWN files, without the replied-to message's (see {@link ownImages} for why). */
export function ownFiles(m: TelegramMessage): string[] {
  return [m.document?.file_id, m.voice?.file_id, m.video?.file_id, m.audio?.file_id].filter((id): id is string =>
    Boolean(id),
  );
}

/** A stable sender label for attribution. In a shared (multi-user) session the model must tell who is
 *  who across turns; a username-less user still gets a name + id rather than vanishing. */
export function fromLabel(from: TelegramMessage["from"]): string | undefined {
  if (!from) return undefined;
  return from.username ? `@${from.username}` : `${from.first_name ?? "user"} (id ${from.id})`;
}

/** A one-line description of a message's attachment, so the envelope names what was sent even before
 *  the agent opens it (and so a media-only message isn't blank). */
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

/** A message's readable body: its text, else its caption, else a one-line attachment summary; undefined
 *  for an empty/service message. The single source for "what did this message say" — envelope, reply-
 *  quote, and the context-buffer line all read through it so their fallbacks cannot drift apart. */
function bodyOf(m: TelegramMessage): string | undefined {
  return m.text ?? m.caption ?? attachmentSummary(m);
}

/** A one-line, length-capped rendering of a message's content for the context buffer. */
export function messageText(m: TelegramMessage): string {
  return (bodyOf(m) ?? "").replace(/\s+/g, " ").trim().slice(0, 280);
}

/**
 * The default base prompt: a context envelope (chat/thread/sender + a group note + reply) then the
 * user's text/caption and a compact rendering of structured payloads (location/contact/poll). The
 * sender is named on every message and a group chat is flagged — in a shared multi-user session that is
 * how the model tells participants apart and knows it is not a 1:1. The reply
 * block carries the replied-to sender, message id, and text/caption or an attachment summary (and the
 * channel downloads a replied-to file/photo too). Exported so a custom `route` can reuse it, e.g.
 * `text: `${telegramEnvelope(m)}\n\n[extra]``. The channel still appends downloaded attachments.
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
  // In a shared group session the model sees turns from different people (each `from`-tagged); tell it
  // so it addresses participants by name and does not assume one continuous interlocutor. A 1:1 DM is
  // self-evident, so no note there.
  const isGroup = m.chat.type === "group" || m.chat.type === "supergroup";
  const scope = isGroup ? "\n[group chat — multiple people; each message is prefixed with its sender]" : "";
  const replyTo = r
    ? `\n[in reply to ${fromLabel(r.from) ?? `msg ${r.message_id}`} (msg ${r.message_id}): ${(bodyOf(r) ?? "(empty)").slice(0, 280)}]`
    : "";
  const parts = [bodyOf(m) ?? ""];
  if (m.location) parts.push(`[location: ${m.location.latitude},${m.location.longitude}]`);
  if (m.contact) parts.push(`[contact: ${m.contact.first_name} ${m.contact.phone_number ?? ""}]`);
  if (m.poll) parts.push(`[poll: ${m.poll.question} — ${(m.poll.options ?? []).map((o) => o.text).join(" / ")}]`);
  return `[telegram: ${meta}]${scope}${replyTo}\n${parts.filter(Boolean).join("\n")}`;
}

/** Normalize a configured bot username: drop a leading `@`, trim, lowercase (usernames are case-
 *  insensitive). Undefined when unknown. */
function botName(botUsername: string | undefined): string | undefined {
  const s = botUsername?.replace(/^@/, "").trim().toLowerCase();
  return s || undefined;
}

/**
 * Whether the message @mentions the bot — read from the `mention` ENTITIES Telegram's server already
 * parsed, not a regex over the raw text. The entity type excludes by construction what a text scan
 * false-matches: `@bot` inside a code block or a URL is not a `mention` entity, a glued `/cmd@bot` is a
 * `bot_command` — and slicing the exact offset/length range makes `@fast` vs `@fastagent` confusion
 * impossible. (Offsets are UTF-16 code units = native JS string indexing.) No text fallback: mention
 * entities are produced server-side, so their absence means there is no mention.
 */
function mentionsBot(m: TelegramMessage, botUsername: string | undefined): boolean {
  const name = botName(botUsername);
  if (!name) return false;
  const text = m.text ?? m.caption ?? "";
  const entities = (m.text !== undefined ? m.entities : m.caption_entities) ?? [];
  return entities.some(
    (e) => e.type === "mention" && text.slice(e.offset, e.offset + e.length).toLowerCase() === `@${name}`,
  );
}

/** Whether the message replies to THIS bot — not just any bot: in a multi-bot group, replying to
 *  another bot must not summon ours. Identity is the bot's numeric id (stable; a username is a mutable
 *  handle) — telegramChannel parses it synchronously from the token, so there is no resolution race.
 *  Without an id, fall back to username; with NEITHER, fail closed (false): answering "is this a reply
 *  to me?" with "I don't know who I am, so yes" would mis-summon in every multi-bot group — a caller
 *  reusing the route bare must supply an identity to get reply summon. */
function repliesToBot(m: TelegramMessage, options?: { botUsername?: string; botId?: number }): boolean {
  const r = m.reply_to_message?.from;
  if (r?.is_bot !== true) return false;
  if (options?.botId !== undefined) return r.id === options.botId;
  const name = botName(options?.botUsername);
  return name !== undefined && r.username?.toLowerCase() === name;
}

/**
 * The default routing policy (used when `route` is omitted; exported so a custom route can reuse it):
 * answer private chats always; a group only on a reply to THIS bot (by `botId`) or a `mention` entity
 * naming it (when `botUsername` is supplied — telegramChannel parses the id from the token and resolves
 * the username via getMe). A bare or directed slash command does NOT summon in a group (that was noisy;
 * a bot author who wants commands adds a custom route). Returns `{}` (act; the channel fills
 * session/target/prompt from the message) or `null` (ignore).
 */
export function defaultTelegramRoute(
  update: TelegramUpdate,
  options?: { botUsername?: string; botId?: number },
): TelegramRoute | null {
  const m = pickMessage(update);
  if (!m) return null;
  const summoned = m.chat.type === "private" || repliesToBot(m, options) || mentionsBot(m, options?.botUsername);
  return summoned ? {} : null;
}
