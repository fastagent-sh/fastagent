/**
 * Telegram bot channel: verify the webhook secret token → decide via `route(update)` → run the turn →
 * stream the agent's reply back to the chat, ACK 200. Reply model A: the channel holds the bot token
 * and posts the reply itself (chat UX), unlike the github channel's fire-and-forget. No SDK — inbound
 * is a JSON POST, outbound is a `fetch` to the Bot API. The developer writes only `route` (policy); the
 * channel owns transport + format + attachments.
 *
 * This file is the Telegram DOMAIN: ingress + summon policy + prompt assembly. The subsystems it
 * composes each own their invariants in their own module:
 *   - turn-store.ts     durable per-session serial execution, crash recovery, redelivery dedup
 *   - context-buffer.ts un-summoned group discussion, folded into the next answered turn
 *   - preview.ts        the live-preview pump ("💭 Thinking…" → edits → final answer) + terminal writes
 *   - telegram-api.ts   the single Bot API pipeline (timeouts, 429, ok-gating, HTML-aware split)
 *   - state.ts          atomic state files under the channel-state home
 *
 * Threaded Mode (topics in private chats, a @BotFather toggle) is auto-adapted: an update carrying
 * message_thread_id replies into that thread; without one the chat is linear. Same code, both modes.
 *
 * Authored against the public `@kid7st/fastagent` surface only (the contract + the channel-authoring
 * kit: readBodyCapped / text), so it is exactly what a third-party `fastagent-channel-*` package would write.
 */
import { timingSafeEqual } from "node:crypto";
import { join, resolve } from "node:path";
import type { Agent, AgentEvent, ImageRef } from "../../agent.ts";
import { log } from "../../log.ts";
import { readBodyCapped } from "../body.ts";
import { text } from "../respond.ts";
import { type BufferedRef, collectAttachments, createContextBuffer } from "./context-buffer.ts";
import { type TelegramFailure, defaultErrorMessage, streamReply } from "./preview.ts";
import { ensureStateHome } from "./state.ts";
import { type DownloadedFile, type Target, callApi, resolveFiles, resolveImages, sendMessage } from "./telegram-api.ts";
import { type TurnRecord, createTurnStore } from "./turn-store.ts";

export type { TelegramFailure };

/** Update body cap — Telegram updates are small JSON; 1 MiB is generous and guards a public endpoint. */
const MAX_UPDATE_BYTES = 1 << 20;

/** One accepted-but-unfinished turn, as persisted in the turn store's WAL: everything needed to run it
 *  again after a restart (Telegram never redelivers an ACKed update, so this record IS the turn). */
interface PendingTurn extends TurnRecord {
  /** The "⏳ queued" notice's message_id, when one was sent — the turn's preview takes it over (and a
   *  replay after a restart reuses it instead of orphaning it). */
  previewId?: number;
  placeKey: string;
  baseText: string;
  chatId: number | string;
  threadId?: number;
  replyTo?: number;
  imageFileIds: string[];
  fileIds: string[];
}

/** Shape validation at the turn store's IO boundary (the record shape is this channel's, not the store's). */
function isPendingTurn(r: unknown): r is PendingTurn {
  const t = r as PendingTurn;
  return (
    typeof t?.id === "string" &&
    (t.state === "queued" || t.state === "started") &&
    typeof t.session === "string" &&
    typeof t.placeKey === "string" &&
    typeof t.baseText === "string" &&
    (typeof t.chatId === "number" || typeof t.chatId === "string") &&
    (t.threadId === undefined || typeof t.threadId === "number") &&
    (t.replyTo === undefined || typeof t.replyTo === "number") &&
    (t.previewId === undefined || typeof t.previewId === "number") &&
    Array.isArray(t.imageFileIds) &&
    t.imageFileIds.every((x) => typeof x === "string") &&
    Array.isArray(t.fileIds) &&
    t.fileIds.every((x) => typeof x === "string")
  );
}

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

export interface TelegramChannelOptions {
  /** Webhook secret token (the `secret_token` you set via setWebhook); verifies inbound updates. */
  secretToken: string;
  /** Bot token — used to send the agent's reply via the Bot API. */
  botToken: string;
  /** Policy: whether/where to answer an update (return null to ignore). Defaults to {@link defaultTelegramRoute}. */
  route?: (update: TelegramUpdate) => TelegramRoute | null;
  /**
   * Customer-facing failure text for the chat (the dev-facing full `details` always go to the operator
   * log). Return a string to send it, or undefined/"" to stay silent. Default: a neutral message keyed
   * on `retryable`. A developer's own bot can surface the raw details, e.g. `(f) => `⚠️ ${f.details}``.
   */
  onError?: (failed: TelegramFailure) => string | undefined;
  /** Bot @username for group @mention summon by the default route (else resolved via getMe). */
  botUsername?: string;
  /** Bot API base, for tests. Defaults to the public Telegram endpoint. */
  apiBaseUrl?: string;
  /** Where the channel persists its durable state (the group-context buffer and the pending-turn
   *  queue). Defaults to `.fastagent/channels/telegram` under the working directory — the channel-state
   *  convention (engine state lives at the `.fastagent` top level, channel state under
   *  `channels/<kind>/`). Single-process: two processes must not share a state dir. */
  stateDir?: string;
}

/** Constant-time compare so the secret-token check leaks no timing signal. */
function tokenMatches(header: string, secret: string): boolean {
  const a = Buffer.from(header);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Appended to the prompt (not the system prompt): the channel owns Telegram-HTML formatting. */
const HTML_INSTRUCTION =
  "\n\n(Format your reply in Telegram-supported HTML — <b> <i> <u> <s> <code> <pre> <a href> — not Markdown.)";

/**
 * agent.invoke, but resolve the message's attachments first: images (vision) inline, and files
 * downloaded to disk with their absolute paths appended to the prompt so the agent can read them with
 * its tools. A transport failure becomes a `failed` event — surfaced (user + log), never a silent drop;
 * the agent never runs on inputs the user sent but we failed to load. `buffered` attachments (posted in
 * the un-summoned discussion) are BACKGROUND context, so their failures degrade instead — a warn + a
 * prompt note — rather than failing the ask they merely accompany. `onCompleted` (if given) fires on
 * the turn's `completed` event — the commit point for clearing the folded-in context buffer: only then
 * does the folded discussion provably live in the durable session, so a failure or crash at ANY earlier
 * point leaves the buffer intact for the next summon (a re-folded block beats lost context).
 */
async function* invokeWithAttachments(
  agent: Agent,
  session: string,
  text: string,
  chatId: number | string,
  imageFileIds: string[] | undefined,
  fileIds: string[] | undefined,
  api: string,
  botToken: string,
  filesDir: string,
  buffered: { files: BufferedRef[]; images: BufferedRef[]; skipped: number },
  onCompleted?: () => void,
): AsyncIterable<AgentEvent> {
  let images: ImageRef[] | undefined;
  let files: DownloadedFile[] | undefined;
  try {
    images = await resolveImages(api, botToken, imageFileIds);
    files = await resolveFiles(api, botToken, fileIds, chatId, filesDir);
  } catch (e) {
    yield { type: "failed", details: `could not load attachment: ${String(e)}`, retryable: true };
    return;
  }
  // Background context — degrade PER ATTACHMENT, don't fail the ask: one expired earlier file must
  // neither block the answer nor drag down its still-valid siblings. The note counts EVERY missing one
  // (load failures + cap-skipped), so the model never holds an attachment reference it silently cannot
  // open.
  // Parallel (allSettled keeps input order and per-attachment isolation — the whole point of not
  // batching them into one resolve call): serially, up to 2×BUFFER_ATTACH_MAX two-hop downloads would
  // stack on the critical path before the agent even starts.
  const bufferedImages: ImageRef[] = [];
  const bufferedFiles: { file: DownloadedFile; ref: BufferedRef }[] = [];
  let lost = 0;
  const imageResults = await Promise.allSettled(buffered.images.map((ref) => resolveImages(api, botToken, [ref.id])));
  for (const r of imageResults) {
    if (r.status === "fulfilled") bufferedImages.push(...(r.value ?? []));
    else {
      lost++;
      log.warn(`[telegram] could not load an earlier (buffered) photo: ${String(r.reason)}`);
    }
  }
  const fileResults = await Promise.allSettled(
    buffered.files.map(async (ref) => ({
      ref,
      files: (await resolveFiles(api, botToken, [ref.id], chatId, filesDir)) ?? [],
    })),
  );
  for (const r of fileResults) {
    if (r.status === "fulfilled") {
      for (const file of r.value.files) bufferedFiles.push({ file, ref: r.value.ref });
    } else {
      lost++;
      log.warn(`[telegram] could not load an earlier (buffered) attachment: ${String(r.reason)}`);
    }
  }
  const missing = lost + buffered.skipped;
  const bufferedNote =
    missing > 0
      ? `\n[note: ${missing} attachment(s) from the earlier discussion are not loaded (expired, or older than the most recent few)]`
      : "";
  // PRIMARY first, background after — consistent with "primary wins": what the user pointed at this
  // turn leads. Buffered file entries are attributed like the fold's text lines ("the file Bob sent"
  // resolves); buffered PHOTOS cannot be (ImageRef carries no label), so their attribution stops at
  // the fold's attachment markers (the buffer appends `[photo]` even to captioned lines) — a
  // documented limit.
  const allFiles = [
    ...(files ?? []),
    ...bufferedFiles.map(({ file, ref }) => ({
      ...file,
      name: `${file.name} (from ${ref.from}${ref.msg !== undefined ? `, msg ${ref.msg}` : ""}, earlier discussion)`,
    })),
  ];
  const manifest = allFiles.length
    ? `\n\n[attached files — read them with your tools:\n${allFiles.map((f) => `- ${f.name} (${f.size} bytes) → ${f.path}`).join("\n")}\n]`
    : "";
  const allImages = [...(images ?? []), ...bufferedImages];
  for await (const e of agent.invoke(
    { session },
    { text: `${text}${bufferedNote}${manifest}${HTML_INSTRUCTION}`, images: allImages.length ? allImages : undefined },
  )) {
    if (e.type === "completed") onCompleted?.(); // the turn is durably in the session — commit point
    yield e;
  }
}

/** The actionable message in an update (a fresh message or channel post). Edits (`edited_message` /
 *  `edited_channel_post`) are deliberately NOT actionable: answering them re-answers every typo fix (a
 *  duplicate reply per edit), so an edited message changes nothing — the standard bot behavior. The
 *  trade-off: editing a mention INTO an old message does not summon either; send a new message. */
function pickMessage(update: TelegramUpdate): TelegramMessage | undefined {
  return update.message ?? update.channel_post;
}

/** file_ids to send the model as vision images: this message's largest photo + a replied-to photo. */
function extractImages(m: TelegramMessage): string[] {
  return [...ownImages(m), ...(m.reply_to_message ? ownImages(m.reply_to_message) : [])];
}

/** The message's OWN photo (largest size), without the replied-to message's — the buffer path uses
 *  this: each message is its own entry there, so counting the replied-to attachment again would
 *  duplicate it and squeeze the attachment cap (the reply relation is expressed by `replyTo` instead). */
function ownImages(m: TelegramMessage): string[] {
  return [m.photo?.at(-1)?.file_id].filter((id): id is string => Boolean(id));
}

/** file_ids to download to disk for the agent's tools: this message's files + a replied-to message's
 *  (so "summarize this file" works when the user replies to a document with the mention). */
function extractFiles(m: TelegramMessage): string[] {
  return [...ownFiles(m), ...(m.reply_to_message ? ownFiles(m.reply_to_message) : [])];
}

/** The message's OWN files, without the replied-to message's (see {@link ownImages} for why). */
function ownFiles(m: TelegramMessage): string[] {
  return [m.document?.file_id, m.voice?.file_id, m.video?.file_id, m.audio?.file_id].filter((id): id is string =>
    Boolean(id),
  );
}

/** A stable sender label for attribution. In a shared (multi-user) session the model must tell who is
 *  who across turns; a username-less user still gets a name + id rather than vanishing. */
function fromLabel(from: TelegramMessage["from"]): string | undefined {
  if (!from) return undefined;
  return from.username ? `@${from.username}` : `${from.first_name ?? "user"} (id ${from.id})`;
}

/** A one-line description of a message's attachment, so the envelope names what was sent even before
 *  the agent opens it (and so a media-only message isn't blank). */
function attachmentSummary(m: TelegramMessage): string | undefined {
  if (m.photo?.length) return "[photo]";
  if (m.document) {
    return `[document: ${m.document.file_name ?? "file"}${m.document.mime_type ? ` (${m.document.mime_type})` : ""}]`;
  }
  if (m.voice) return "[voice message]";
  if (m.video) return "[video]";
  if (m.audio) return "[audio]";
  return undefined;
}

/** A one-line, length-capped rendering of a message's content for the context buffer. */
function messageText(m: TelegramMessage): string {
  return (m.text ?? m.caption ?? attachmentSummary(m) ?? "").replace(/\s+/g, " ").trim().slice(0, 280);
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
    ? `\n[in reply to ${fromLabel(r.from) ?? `msg ${r.message_id}`} (msg ${r.message_id}): ${(r.text ?? r.caption ?? attachmentSummary(r) ?? "(empty)").slice(0, 280)}]`
    : "";
  const parts = [m.text ?? m.caption ?? attachmentSummary(m) ?? ""];
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

/** Build a Telegram bot channel for `agent`: a Fetch handler to mount at your webhook route (POST). */
export function telegramChannel(
  agent: Agent,
  {
    secretToken,
    botToken,
    route,
    onError,
    botUsername,
    apiBaseUrl = "https://api.telegram.org",
    stateDir = join(process.cwd(), ".fastagent", "channels", "telegram"),
  }: TelegramChannelOptions,
): (req: Request) => Promise<Response> {
  // Both are mandatory: an unset secret_token would accept forged updates (the endpoint is public);
  // the bot token is required to send the reply. Fail at construction (startup), not silently.
  if (!secretToken) {
    throw new Error(
      "telegramChannel requires a non-empty secretToken (the webhook secret_token; an unset one accepts forged updates)",
    );
  }
  if (!botToken) {
    throw new Error("telegramChannel requires a non-empty botToken (used to send the agent's reply)");
  }
  const formatError = onError ?? defaultErrorMessage;
  // One getMe at startup: the bot's @username (for the default route's group @mention summon, only when
  // not supplied) and the group-privacy flag — privacy mode off is required to receive the un-summoned
  // group messages that feed the context buffer, so warn if it is on.
  let mentionName = botUsername;
  void callApi(apiBaseUrl, botToken, "getMe", {}).then(
    (me) => {
      if (mentionName === undefined) mentionName = me.username;
      if (me.can_read_all_group_messages === false) {
        log.warn(
          "[telegram] privacy mode is on: the bot only sees @mentions / replies / commands, so group " +
            "context (un-summoned messages) won't be captured. Disable it via @BotFather → /setprivacy.",
        );
      }
    },
    (e) => log.warn(`[telegram] getMe failed; @mention summon + privacy check skipped: ${String(e)}`),
  );
  // A bot token is "<bot_id>:<secret>" — the bot's own id is knowable synchronously, so reply-to-bot
  // targeting is precise from the first update (no getMe race; getMe only resolves the @username).
  // Every real token parses; one that doesn't (a mock/test token) degrades visibly: reply summon stays
  // off (fail-closed in repliesToBot) until getMe supplies the username tier.
  const tokenId = Number(botToken.split(":")[0]);
  const botId = Number.isSafeInteger(tokenId) && tokenId > 0 ? tokenId : undefined;
  if (botId === undefined) {
    log.warn("[telegram] bot token has no parseable bot id — reply-to-bot summon disabled until getMe resolves");
  }
  const decide =
    route ?? ((update: TelegramUpdate) => defaultTelegramRoute(update, { botUsername: mentionName, botId }));

  // Normalize once: a relative stateDir resolves against the process cwd HERE, so every derived path
  // (incl. the attachment paths handed to the agent) honours DownloadedFile's absolute-path contract.
  const stateHome = resolve(stateDir);
  ensureStateHome(stateHome); // create + self-ignore — buffers/WAL/files may carry chat content
  const buffer = createContextBuffer(join(stateHome, "buffers.json"));

  // In-memory: the in-flight "⏳ queued" notice per turn, awaited at dequeue so the turn reliably takes
  // the notice message over (rec.previewId) instead of racing it and orphaning a late-arriving notice.
  const notices = new Map<string, Promise<void>>();
  const store = createTurnStore<PendingTurn>({
    path: join(stateHome, "queue.json"),
    label: "[telegram]",
    isRecord: isPendingTurn,
    // Queue feedback: when this session already has a turn running/queued, a silent wait reads as "the
    // bot ignored me" once the current turn runs long — tell the asker NOW (reply-quoted, so it is
    // clear whose ask is queued). Best-effort and post-ACK: a failed notice is a log line, never a
    // failed update. The turn's live preview then edits this same message in place.
    onQueuedBehind: (rec, s) => {
      if (rec.previewId !== undefined) return; // a replayed record that already has its notice
      const target: Target = { chatId: rec.chatId, threadId: rec.threadId, replyTo: rec.replyTo };
      notices.set(
        rec.id,
        sendMessage(apiBaseUrl, botToken, target, "⏳ Queued — I’ll start once the current task finishes.", {
          html: false,
        }).then(
          (id) => {
            // Through the store, which owns the record — a replay after a restart reuses the notice
            // instead of orphaning it.
            if (id !== undefined) s.update(rec.id, { previewId: id });
          },
          (e) => log.warn(`[telegram] queue notice failed (the turn still runs): ${String(e)}`),
        ),
      );
    },
    run: async (rec, s) => {
      // Runs at DEQUEUE time (serialized), so the lifecycle log and engine turn reflect the actual
      // execution order rather than arrival.
      // Settle the queue notice (if any) so rec.previewId is final. NOT free: a slow (not failed)
      // notice delays this turn's start by up to the API timeout — accepted, because racing it would
      // orphan the ⏳ message and double-post a placeholder; in the common path the notice resolved
      // while the previous turn was still running, so this await is instant.
      await notices.get(rec.id);
      notices.delete(rec.id);
      s.started(rec.id); // output becomes possible from here — a crash past this point must not replay
      const startedAt = Date.now();
      const where = `chat=${rec.chatId}${rec.threadId !== undefined ? ` thread=${rec.threadId}` : ""}`;
      log.info(`[telegram] turn start: turn=${rec.id} session=${rec.session} ${where}`);
      // Fold the un-summoned discussion since the last answered turn into the prompt; it is cleared
      // only when the turn COMPLETES (then it lives in the session).
      const { text: recent, consumed } = buffer.peek(rec.placeKey);
      const prompt = recent ? `[recent group discussion:\n${recent}\n]\n\n${rec.baseText}` : rec.baseText;
      const buffered = collectAttachments(consumed, {
        files: new Set(rec.fileIds),
        images: new Set(rec.imageFileIds),
      });
      const target: Target = { chatId: rec.chatId, threadId: rec.threadId, replyTo: rec.replyTo };
      try {
        await streamReply(
          invokeWithAttachments(
            agent,
            rec.session,
            prompt,
            rec.chatId,
            rec.imageFileIds,
            rec.fileIds,
            apiBaseUrl,
            botToken,
            join(stateHome, "files"),
            buffered,
            () => buffer.commit(rec.placeKey, consumed),
          ),
          apiBaseUrl,
          botToken,
          target,
          formatError,
          rec.previewId,
        );
        log.info(`[telegram] turn done: turn=${rec.id} session=${rec.session} (${Date.now() - startedAt}ms)`);
      } catch (error) {
        log.error(
          `[telegram] turn failed: turn=${rec.id} session=${rec.session} (${Date.now() - startedAt}ms): ${String(error)}`,
        );
      }
    },
  });

  return async (req) => {
    if (req.method !== "POST") return text("POST only\n", 405);
    // Fail closed: a missing/wrong secret token is 401, never routed.
    if (!tokenMatches(req.headers.get("x-telegram-bot-api-secret-token") ?? "", secretToken)) {
      return text("invalid secret token\n", 401);
    }
    const body = await readBodyCapped(req, MAX_UPDATE_BYTES);
    if ("tooLarge" in body) return text("payload too large\n", 413);
    let update: TelegramUpdate;
    try {
      update = JSON.parse(body.text) as TelegramUpdate;
    } catch {
      return text("invalid json\n", 400);
    }

    // Decide whether/where to answer, then run the turn. ACK 200 immediately (the turn may outlast the
    // webhook timeout); lifecycle goes to stderr — after the 200 there is no response body, so those
    // lines are the operator's only signal.
    const m = pickMessage(update);
    if (!m) return new Response(null, { status: 200 });
    // A redelivery of an update whose turn the store's recovery already took over (replayed or
    // dropped): ACK and skip — Telegram redelivers exactly when the 200 never made it out, which is
    // the crash window recovery covers; running it again would answer twice.
    if (store.suppressed(`${update.update_id}`)) {
      log.info(`[telegram] suppressing redelivered update ${update.update_id} — recovery already handled it`);
      return new Response(null, { status: 200 });
    }
    const placeKey = m.message_thread_id ? `${m.chat.id}:${m.message_thread_id}` : `${m.chat.id}`;
    const r = decide(update);
    if (!r) {
      // Not summoned: in a group, record the message so a later summon has the discussion (needs privacy
      // off to be delivered here at all). Empty/service messages and non-group chats keep no buffer.
      const isGroup = m.chat.type === "group" || m.chat.type === "supergroup";
      const content = messageText(m);
      if (isGroup && content) {
        // OWN attachments only: each message is its own buffer entry, so a reply's referenced
        // attachment is already (or will be) the other entry's — recounting it here would duplicate
        // downloads and squeeze the attachment cap.
        const fileIds = ownFiles(m);
        const imageIds = ownImages(m);
        // A captioned attachment renders as its caption — append the attachment marker so the fold
        // ALWAYS labels attachments (that label + sender is all the attribution a photo gets).
        const summary = attachmentSummary(m);
        const bodyLine = summary && content !== summary ? `${content} ${summary}` : content;
        buffer.push(placeKey, {
          sender: fromLabel(m.from) ?? "someone",
          body: bodyLine,
          messageId: m.message_id,
          replyTo: m.reply_to_message?.message_id,
          fileIds: fileIds.length ? fileIds : undefined,
          imageIds: imageIds.length ? imageIds : undefined,
        });
      }
      return new Response(null, { status: 200 });
    }
    {
      const session = r.session ?? placeKey;
      const chatId = r.chatId ?? m.chat.id;
      // Reply to the summoning message in groups (threads the answer under the asker); a 1:1 DM needs no
      // reply-quote. Only when the RESOLVED target is the message's own chat+thread: a route that
      // redirects elsewhere must not carry a reply_parameters that resolves in the wrong place (fail, or
      // quote a same-id message there). Compare VALUES, not whether the route touched the field — a route
      // that explicitly returns the same chat/thread still quotes.
      const threadId = r.threadId ?? m.message_thread_id;
      const sameTarget = String(chatId) === String(m.chat.id) && threadId === m.message_thread_id;
      const baseText = r.text ?? telegramEnvelope(m);
      const imageFileIds = extractImages(m);
      const fileIds = extractFiles(m);
      if (baseText.trim() !== "" || imageFileIds.length > 0 || fileIds.length > 0) {
        // Everything the turn needs, as a plain record — the store persists it before this handler's
        // 200 (durable-or-nothing), so an accepted turn survives a crash; file_ids stay resolvable for
        // a replay.
        store.accept({
          id: `${update.update_id}`,
          state: "queued",
          session,
          placeKey,
          baseText,
          chatId,
          threadId,
          replyTo: m.chat.type !== "private" && sameTarget ? m.message_id : undefined,
          imageFileIds,
          fileIds,
        });
      }
    }
    return new Response(null, { status: 200 });
  };
}
