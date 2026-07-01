/**
 * Telegram bot channel: verify the webhook secret token → decide via `route(update)` → run the turn →
 * stream the agent's reply back to the chat, ACK 200. Reply model A: the channel holds the bot token
 * and posts the reply itself (chat UX), unlike the github channel's fire-and-forget. No SDK — inbound
 * is a JSON POST, outbound is a `fetch` to the Bot API. The developer writes only `route` (policy); the
 * channel owns transport + format + attachments.
 *
 * Live streaming: a single "💭 Thinking…" message is sent once, then editMessageText'd in place with the
 * latest tool calls + partial text (PLAIN — a partial answer may carry unbalanced HTML); on completion
 * the same message is edited into the final answer as HTML. One message, works in groups and private
 * (unlike sendMessageDraft, which is private/forum-topic only). Threaded Mode (topics in private
 * chats, a @BotFather toggle) is auto-adapted: an update carrying message_thread_id replies into that
 * thread; without one the chat is linear. Same code, both modes.
 *
 * Authored against the public `@kid7st/fastagent` surface only (the contract + the channel-authoring
 * kit: readBodyCapped / text), so it is exactly what a third-party `fastagent-channel-*` package would write.
 */
import { timingSafeEqual } from "node:crypto";
import type { Agent, AgentEvent, ImageRef, Json } from "../../agent.ts";
import { log } from "../../log.ts";
import { readBodyCapped } from "../body.ts";
import {
  type DownloadedFile,
  type Target,
  resolveBotInfo,
  resolveFiles,
  resolveImages,
  chunkText,
  deleteMessage,
  editMessageText,
  sendMessage,
} from "./telegram-api.ts";
import { text } from "../respond.ts";

/** Update body cap — Telegram updates are small JSON; 1 MiB is generous and guards a public endpoint. */
const MAX_UPDATE_BYTES = 1 << 20;

/** Char budget for the per-place group-context buffer — bounds the cost of folding it into a prompt;
 *  when exceeded the OLDEST un-summoned messages are dropped (not a time window: a quiet group keeps its
 *  sparse-but-relevant lines, a busy burst is capped). */
const BUFFER_MAX_CHARS = 4000;

/** One buffered un-summoned message: its sender label and one-line body (object identity is the commit key). */
interface BufferEntry {
  sender: string;
  body: string;
}

/** How often (ms) to edit the live-preview message; tool events still flush on the next loop. Edits to
 *  one message are rate-limited tighter than sends, so pace them ~1.5s (vs every token). */
const EDIT_THROTTLE_MS = 1500;

/** Max length of a tool's arg preview in the live view. */
const TOOL_ARG_MAX = 48;

/** How much of the (growing) reasoning to peek at in the live view — the most recent tail. */
const THINKING_PREVIEW = 280;

/** One-line, truncated: collapse whitespace so a multi-line command/arg stays on one line. */
function clip(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > TOOL_ARG_MAX ? `${one.slice(0, TOOL_ARG_MAX - 1)}…` : one;
}

/**
 * A compact, human-readable preview of a tool call's args so the live view reads `🔧 read AGENTS.md`
 * rather than just `🔧 read`. Generic (the channel knows no tool schemas): show the salient value — the
 * first primitive field, conventionally the subject (path / command / query / url) — else compact JSON.
 */
function summarizeArgs(args: Json): string {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return clip(String(args));
  const values = Object.values(args);
  const primary = values.find((v) => typeof v === "string" || typeof v === "number");
  if (primary !== undefined) return clip(String(primary));
  return values.length > 0 ? clip(JSON.stringify(args)) : "";
}

/** A Telegram message entity (subset): `mention` (`@username`), `bot_command` (`/cmd` or `/cmd@bot`),
 *  a link, etc. `offset`/`length` are UTF-16 code units into the text — matching JS string slicing. */
export interface MessageEntity {
  type: string;
  offset: number;
  length: number;
  [k: string]: unknown;
}

/** A Telegram message (the common subset; `[k]` keeps the rest reachable without a types dependency). */
export interface TelegramMessage {
  message_id: number;
  text?: string;
  /** Entities over `text` (mentions, commands, links…) — used to detect a bot @mention precisely. */
  entities?: MessageEntity[];
  /** Caption on a media message (photo/document/…) — often the user's instruction for the attachment. */
  caption?: string;
  /** Entities over `caption` (same shape as {@link entities}). */
  caption_entities?: MessageEntity[];
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

/** A Telegram update (the common subset). Narrow for what you route on, e.g. `update.message?.text`. */
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
  callback_query?: { id: string; data?: string; message?: TelegramMessage; [k: string]: unknown };
  [k: string]: unknown;
}

/** A terminal failure, as the channel hands it to `onError`. */
export interface TelegramFailure {
  details: string;
  retryable: boolean;
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
 * the agent never runs on inputs the user sent but we failed to load. `onResolved` (if given) fires once
 * the attachments are in hand and the turn is about to reach the agent — the commit point for any
 * pending side effect (clearing the folded-in context buffer), so a pre-agent failure leaves it intact.
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
  onResolved?: () => void,
): AsyncIterable<AgentEvent> {
  let images: ImageRef[] | undefined;
  let files: DownloadedFile[] | undefined;
  try {
    images = await resolveImages(api, botToken, imageFileIds);
    files = await resolveFiles(api, botToken, fileIds, chatId);
  } catch (e) {
    yield { type: "failed", details: `could not load attachment: ${String(e)}`, retryable: true };
    return;
  }
  onResolved?.(); // attachments are in hand — about to reach the agent, safe to commit pending effects
  const manifest = files?.length
    ? `\n\n[attached files — read them with your tools:\n${files.map((f) => `- ${f.name} (${f.size} bytes) → ${f.path}`).join("\n")}\n]`
    : "";
  yield* agent.invoke({ session }, { text: `${text}${manifest}${HTML_INSTRUCTION}`, images });
}

/** The customer-facing default: neutral, no leaked internals; differentiate only on whether to retry. */
function defaultErrorMessage(failed: TelegramFailure): string {
  return failed.retryable ? "⚠️ Temporary problem — please try again." : "⚠️ Sorry, something went wrong.";
}

/**
 * The terminal-write POLICY: resolve the single preview message into `text`. streamReply owns the
 * preview lifecycle, so this composition of transport primitives lives here, not in telegram-api. One
 * message → edit the preview in place; if the edit fails (preview gone, or a persistent 429/5xx) fall
 * back to deleting the placeholder and sending fresh, so no "Thinking…" is left pinned above the answer.
 * Many messages → delete the preview and send the whole answer as consecutive fresh messages (editing
 * would pin the first chunk where an active group has scrolled past). No preview → fresh send. EMPTY text
 * = "say nothing" → just delete the preview.
 */
async function finalize(
  api: string,
  botToken: string,
  target: Target,
  messageId: number | undefined,
  text: string,
  opts: { html?: boolean } = {},
): Promise<void> {
  const html = opts.html ?? true;
  if (text.trim() === "") {
    if (messageId !== undefined) await deleteMessage(api, botToken, target, messageId);
    return;
  }
  if (messageId !== undefined) {
    if (chunkText(text).length === 1) {
      try {
        await editMessageText(api, botToken, target, messageId, text, { html });
        return;
      } catch {
        // Edit failed — the preview may be gone, or still there (429 retries exhausted / 5xx). Fall through
        // to delete + fresh send below so a still-present "Thinking…" is not left pinned above the answer.
      }
    }
    // Many chunks, OR a failed single-chunk edit: remove the placeholder best-effort (a lingering one above
    // the answer is worse than the extra call), then send the whole reply as fresh, consecutive messages.
    await deleteMessage(api, botToken, target, messageId).catch(() => {});
  }
  await sendMessage(api, botToken, target, text, { html });
}

/**
 * Consume one turn's event stream into a Telegram chat, live. A single preview message is sent once and
 * editMessageText'd in place with the latest tool calls + partial text (PLAIN); on completion it is
 * edited into the final answer (HTML). Preview edits are best-effort (logged once if they fail); the
 * final write is authoritative and surfaces a real failure (bad token, etc.).
 */
async function streamReply(
  events: AsyncIterable<AgentEvent>,
  api: string,
  botToken: string,
  target: Target,
  formatError: (failed: TelegramFailure) => string | undefined,
): Promise<void> {
  const tools: { label: string; status: "running" | "ok" | "error" }[] = [];
  const toolIndexById = new Map<string, number>();
  let thinking = "";
  let answer = "";

  const mark = { running: "…", ok: "✓", error: "✗" } as const;
  const toolView = (): string => tools.map((t) => `🔧 ${t.label} ${mark[t.status]}`).join("\n");
  // Reasoning is process, not the answer: shown (capped to its tail) in the live preview only, never
  // in the persisted final message (which is `answer` alone).
  const thinkingView = (): string => {
    const t = thinking.replace(/\s+/g, " ").trim();
    if (t === "") return "";
    return `💭 ${t.length > THINKING_PREVIEW ? `…${t.slice(t.length - THINKING_PREVIEW + 1)}` : t}`;
  };
  const view = (): string => {
    const v = [thinkingView(), toolView(), answer]
      .filter((s) => s.trim() !== "")
      .join("\n\n")
      .trim();
    // Before any reasoning/tool/text arrives, show an explicit placeholder rather than an empty edit.
    return v === "" ? "💭 Thinking…" : v;
  };

  // The live preview is ONE real message: sent once (capturing its id + threading under the asker),
  // then edited in place. messageId/lastSent are shared with the final write on completion.
  let messageId: number | undefined;
  let previewSent = false; // a placeholder send was attempted — guards against re-sending when no id came back
  let finalized = false; // a terminal write (completed/failed) ran — the finally skips its orphan cleanup
  let lastSent = "";
  const flushPreview = async (): Promise<void> => {
    const text = view();
    if (text === lastSent) return; // skip an unchanged edit (Telegram rejects "message is not modified")
    lastSent = text;
    if (messageId !== undefined) {
      await editMessageText(api, botToken, target, messageId, text); // plain — a partial answer may carry unbalanced HTML
      return;
    }
    // No preview message yet. Send the placeholder ONCE; never re-send (that would spam a new message per
    // frame). If Telegram returns ok WITHOUT a message_id (proxy / odd API base / unparseable body) we
    // cannot edit — fail visibly and stop previewing (the final write still lands via finalize).
    if (previewSent) return;
    previewSent = true;
    messageId = await sendMessage(api, botToken, target, text, { html: false });
    if (messageId === undefined)
      throw new Error("telegram sendMessage returned ok without a message_id — live preview disabled for this turn");
  };

  // ── Live-preview pump: a SINGLE serialized writer. ──────────────────────────────────────────
  // Events mutate state (thinking / tools / answer) and mark the preview dirty; the pump edits the
  // message to the LATEST view() with at most ONE edit in flight, paced by a throttle. One-in-flight is
  // the whole point: concurrent edits can reach Telegram out of order — an older frame landing over a
  // newer one is the "shows 3-4 steps, blanks, re-fills" flicker. Serializing keeps frames monotonic.
  // (No keepalive: a real message does not expire, unlike the old 30s draft.)
  let dirty = false;
  let pumping = false;
  let stopped = false;
  let previewErrLogged = false;
  let pumpDone: Promise<void> | undefined;
  let wakeThrottle: (() => void) | undefined; // set while the pump is mid-throttle; finish() cuts it short

  const runPump = async (): Promise<void> => {
    pumping = true;
    try {
      while (dirty && !stopped) {
        dirty = false;
        try {
          await flushPreview();
        } catch (e) {
          // Best-effort preview (the final write is authoritative), but a failing edit must be visible —
          // log once per turn so a never-rendering preview is diagnosable, not silent.
          if (!previewErrLogged) {
            previewErrLogged = true;
            log.warn(`[telegram] live preview failed (final reply still sends): ${String(e)}`);
          }
        }
        if (dirty && !stopped) {
          // Pace + coalesce a burst into one edit. Interruptible: finish() cuts this short so the final
          // write is not delayed by up to EDIT_THROTTLE_MS after the turn completes.
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, EDIT_THROTTLE_MS);
            wakeThrottle = () => {
              clearTimeout(t);
              resolve();
            };
          });
          wakeThrottle = undefined;
        }
      }
    } finally {
      pumping = false;
    }
  };
  // Mark the preview dirty and ensure the single writer is running (an edit already in flight picks up
  // the new state on its next loop). Synchronous — callers never await a network write.
  const touch = (): void => {
    dirty = true;
    if (!pumping) pumpDone = runPump();
  };

  touch(); // send the "💭 Thinking…" placeholder immediately

  // Stop the pump and await any in-flight edit, so the final write below is strictly the LAST one to the
  // preview message (no stale frame landing after the answer).
  const finish = async (): Promise<void> => {
    stopped = true;
    wakeThrottle?.(); // cut an in-flight throttle so the final write is not delayed up to EDIT_THROTTLE_MS
    await pumpDone?.catch(() => {});
  };

  try {
    for await (const e of events) {
      if (e.type === "text") {
        answer += e.delta;
        touch();
      } else if (e.type === "thinking") {
        thinking += e.delta;
        touch();
      } else if (e.type === "tool_started") {
        const arg = summarizeArgs(e.args);
        toolIndexById.set(e.id, tools.length);
        tools.push({ label: arg ? `${e.name} ${arg}` : e.name, status: "running" });
        touch();
      } else if (e.type === "tool_ended") {
        const i = toolIndexById.get(e.id);
        const t = i === undefined ? undefined : tools[i];
        if (t) t.status = e.isError ? "error" : "ok";
        touch();
      } else if (e.type === "completed") {
        await finish();
        // Edit the preview into the final answer (HTML, plain fallback); the persisted message is the
        // answer alone — the process (thinking/tools) was preview-only. Mark finalized BEFORE delivering:
        // the terminal was reached, so a delivery failure here is a plain failure, not an "abnormal exit"
        // (which would wrongly fire the finally's neutral-notice fallback = double delivery + wrong text).
        finalized = true;
        await finalize(api, botToken, target, messageId, answer.trim() !== "" ? answer : "(no reply)");
        return;
      } else if (e.type === "failed") {
        await finish();
        // Two audiences: the chat (customer-facing — formatError, neutral by default) and the operator
        // log (dev-facing — the full details, via the throw below + the handler's catch). Same terminal
        // write as completed: edit → fresh-send if the preview is gone; an empty notice deletes the
        // placeholder (suppress = no residue). HTML like the answer — symmetric, and finalize already
        // falls back to plain if a custom onError returns markup Telegram rejects. Best-effort — we throw
        // below regardless.
        finalized = true;
        {
          const msg = formatError({ details: e.details, retryable: e.retryable }) ?? "";
          await finalize(api, botToken, target, messageId, msg).catch(() => {});
        }
        throw new Error(`agent failed: ${e.details} (retryable=${e.retryable})`);
      }
    }
    throw new Error("stream ended without a terminal event"); // violates SPEC MUST 1
  } finally {
    await finish();
    // Abnormal exit (stream ended without a terminal, the generator threw, or the consumer abandoned): no
    // terminal write ran. Show the SAME neutral notice a `failed` event would — the preview may show real
    // partial work, so don't delete it silently, and don't leave the user in silence. A suppressing
    // onError still collapses to a delete (finalize on empty text).
    if (!finalized) {
      // retryable:false — an abnormal end (no terminal / a throw) is of UNKNOWN retryability, so use the
      // neutral "something went wrong" default rather than promising "try again" that may not help.
      const notice = formatError({ details: "the turn ended without completing", retryable: false }) ?? "";
      // finalize handles messageId===undefined (no preview reached) with a fresh send — so the user is
      // told even when the turn died before any message.
      await finalize(api, botToken, target, messageId, notice).catch(() => {});
    }
  }
}

/** The actionable message in an update (a plain/edited message or channel post). */
function pickMessage(update: TelegramUpdate): TelegramMessage | undefined {
  return update.message ?? update.edited_message ?? update.channel_post ?? update.edited_channel_post;
}

/** file_ids to send the model as vision images: this message's largest photo + a replied-to photo. */
function extractImages(m: TelegramMessage): string[] {
  return [m.photo?.at(-1)?.file_id, m.reply_to_message?.photo?.at(-1)?.file_id].filter((id): id is string =>
    Boolean(id),
  );
}

/** file_ids to download to disk for the agent's tools: this message's files + a replied-to message's
 *  (so "summarize this file" works when the user replies to a document with the mention). */
function extractFiles(m: TelegramMessage): string[] {
  const r = m.reply_to_message;
  return [
    m.document?.file_id,
    m.voice?.file_id,
    m.video?.file_id,
    m.audio?.file_id,
    r?.document?.file_id,
    r?.voice?.file_id,
    r?.video?.file_id,
    r?.audio?.file_id,
  ].filter((id): id is string => Boolean(id));
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

/** The message's text (else caption) with its matching entities — one accessor so mention detection
 *  and stripping read the same source. `text` is undefined only when neither is present. */
function textWithEntities(m: TelegramMessage): { text?: string; entities: MessageEntity[] } {
  if (m.text !== undefined) return { text: m.text, entities: m.entities ?? [] };
  if (m.caption !== undefined) return { text: m.caption, entities: m.caption_entities ?? [] };
  return { entities: [] };
}

/**
 * If entity `e` references our bot (`@botUsername` mention, or a `/cmd@botUsername` command targeting
 * it), the character range `[start, end)` of the `@botUsername` handle token — else null. The ONE place
 * that defines "what counts as the bot's own handle": {@link mentionsBotHandle} asks "does any exist"
 * and {@link stripBotHandle} removes each, so a new case (e.g. `text_mention`) changes both at once. Entity
 * offsets are exact (UTF-16, matching JS slicing), so `@botUsername_typo` can't false-match.
 */
function botHandleRange(text: string, e: MessageEntity, at: string): [number, number] | null {
  const s = text.slice(e.offset, e.offset + e.length).toLowerCase();
  if (e.type === "mention" && s === at) return [e.offset, e.offset + e.length];
  if (e.type === "bot_command" && s.endsWith(at)) return [e.offset + e.length - at.length, e.offset + e.length];
  return null;
}

/**
 * Whether the message references `botUsername` via a Telegram ENTITY (not a loose substring): a
 * `mention` entity that IS `@botUsername`, OR a `bot_command` entity targeting it (`/cmd@botUsername`).
 * The entity-mention arm of the group summon decision — internal; a custom `route` reuses the whole
 * decision via {@link defaultTelegramRoute}, not this sub-predicate. Case-insensitive.
 */
function mentionsBotHandle(m: TelegramMessage, botUsername: string): boolean {
  const { text = "", entities } = textWithEntities(m);
  const at = `@${botUsername}`.toLowerCase();
  return entities.some((e) => botHandleRange(text, e, at) !== null);
}

/**
 * Remove the bot's OWN handle from the text before it reaches the agent — the model should never see
 * `@botUsername` (whether or not it routed the message): `@botUsername` mention tokens, and the
 * `@botUsername` suffix of a `/cmd@botUsername` command (the bare `/cmd` stays). Uses entity offsets so
 * ONLY the exact handle is cut (right-to-left, keeping earlier offsets valid), consuming one adjacent
 * space per cut so no double-space / edge gap is left — the rest of the body (its indentation, alignment,
 * and any pre-existing leading/trailing whitespace) is untouched. No handle → unchanged. Deliberately
 * does NOT trim the whole body: a trim would fire only on this strip path (when `botUsername` is known),
 * so an identical message would read differently before vs after getMe resolves.
 */
function stripBotHandle(text: string, entities: MessageEntity[], botUsername: string): string {
  const at = `@${botUsername}`.toLowerCase();
  const cuts = entities.map((e) => botHandleRange(text, e, at)).filter((r): r is [number, number] => r !== null);
  let out = text;
  for (let [start, end] of cuts.sort((a, b) => b[0] - a[0])) {
    if (out[end] === " ")
      end++; // consume the trailing space, else the leading one — never both
    else if (out[start - 1] === " ") start--;
    out = out.slice(0, start) + out.slice(end);
  }
  return out;
}

/**
 * The default base prompt: a context envelope (chat/thread/sender + a group note + reply) then the
 * user's text/caption and a compact rendering of structured payloads (location/contact/poll). The
 * sender is named on every message and a group chat is flagged — in a shared multi-user session that is
 * how the model tells participants apart and knows it is not a 1:1. The reply
 * block carries the replied-to sender, message id, and text/caption or an attachment summary (and the
 * channel downloads a replied-to file/photo too). With `botUsername`, the bot's OWN `@botUsername`
 * mention (and the `@botUsername` suffix of a `/cmd@botUsername`) is stripped from the user's
 * text/caption — the model should not see its own handle — whether or not that mention is what routed
 * the message. Exported so
 * a custom `route` can reuse it, e.g. `text: `${telegramEnvelope(m)}\n\n[extra]``. The channel still
 * appends downloaded attachments.
 */
export function telegramEnvelope(m: TelegramMessage, options?: { botUsername?: string }): string {
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
  const { text: raw, entities } = textWithEntities(m);
  const body = raw !== undefined && options?.botUsername ? stripBotHandle(raw, entities, options.botUsername) : raw;
  const parts = [body ?? attachmentSummary(m) ?? ""];
  if (m.location) parts.push(`[location: ${m.location.latitude},${m.location.longitude}]`);
  if (m.contact) parts.push(`[contact: ${m.contact.first_name} ${m.contact.phone_number ?? ""}]`);
  if (m.poll) parts.push(`[poll: ${m.poll.question} — ${(m.poll.options ?? []).map((o) => o.text).join(" / ")}]`);
  return `[telegram: ${meta}]${scope}${replyTo}\n${parts.filter(Boolean).join("\n")}`;
}

/**
 * The default routing policy (used when `route` is omitted; exported so a custom route can reuse it):
 * answer private chats always, groups ONLY on a reply to THIS bot or an explicit @mention (via a
 * Telegram entity in the text OR a media caption, when `botUsername` is supplied — telegramChannel
 * resolves it via getMe). A bare slash command no longer summons in groups: `/cmd` there is ambiguous
 * (often meant for another bot), and `/cmd@botUsername` is already caught as an entity mention. Private
 * chats always answer, so their commands still work.
 *
 * The reply arm is exact when `botId` is known (a reply to THIS bot, not any bot in the group); before
 * getMe resolves (or without an id) it falls back to "any bot". Returns `{}` (act; the channel fills
 * session/target/prompt) or `null` (ignore).
 */
export function defaultTelegramRoute(
  update: TelegramUpdate,
  options?: { botUsername?: string; botId?: number },
): TelegramRoute | null {
  const m = pickMessage(update);
  if (!m) return null;
  const repliedTo = m.reply_to_message?.from;
  const repliesToThisBot = options?.botId !== undefined ? repliedTo?.id === options.botId : repliedTo?.is_bot === true;
  const summoned =
    m.chat.type === "private" ||
    repliesToThisBot ||
    (options?.botUsername ? mentionsBotHandle(m, options.botUsername) : false);
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
  let botId: number | undefined;
  void resolveBotInfo(apiBaseUrl, botToken).then(
    (info) => {
      if (mentionName === undefined) mentionName = info.username;
      botId = info.id;
      if (info.canReadAllGroupMessages === false) {
        log.warn(
          "[telegram] privacy mode is on: the bot only sees @mentions / replies / commands, so group " +
            "context (un-summoned messages) won't be captured. Disable it via @BotFather → /setprivacy.",
        );
      }
    },
    (e) =>
      log.warn(
        `[telegram] getMe failed; group @mention + /cmd@bot summon and the privacy check are disabled ` +
          `(set botUsername to keep group summoning; replies to a bot still work): ${String(e)}`,
      ),
  );
  const decide =
    route ?? ((update: TelegramUpdate) => defaultTelegramRoute(update, { botUsername: mentionName, botId }));
  // Per-session serial queue: model B answers a shared chat[:thread] with ONE turn at a time, so a
  // second update for the same session waits its turn (FIFO) instead of colliding on the engine lease
  // and being dropped as "busy" — the wrong UX when several people talk in one group. Different sessions
  // run concurrently (the engine's stateless multi-session invoke). In-process: a restart loses anything
  // still queued (Telegram already got its 200). SPEC §8 leaves this concurrency policy to the channel.
  const sessionChains = new Map<string, Promise<void>>();
  const enqueueTurn = (session: string, task: () => Promise<void>): void => {
    const prev = sessionChains.get(session) ?? Promise.resolve();
    const next = prev.then(task, task); // run after this session's previous turn, in arrival order
    sessionChains.set(session, next);
    void next.finally(() => {
      if (sessionChains.get(session) === next) sessionChains.delete(session); // drop the entry when drained
    });
  };
  // Group-context buffer: recent UN-summoned messages per Telegram "place" (chat[:thread]), kept under
  // a char budget and folded into the next answered turn's prompt so a summoned agent has the discussion
  // it didn't see turn-by-turn. Bucketed by place (not session): an un-summoned message has no route
  // session, and the flush feeds whatever turn answers that place. In-process (a restart loses anything
  // not yet flushed); needs group privacy OFF to receive the messages at all.
  const buffers = new Map<string, BufferEntry[]>();
  const bufferPush = (placeKey: string, sender: string, body: string): void => {
    const buf = buffers.get(placeKey) ?? [];
    buf.push({ sender, body });
    let total = buf.reduce((n, e) => n + e.sender.length + e.body.length + 2, 0);
    while (buf.length > 1 && total > BUFFER_MAX_CHARS) {
      const dropped = buf.shift();
      if (dropped) total -= dropped.sender.length + dropped.body.length + 2;
    }
    buffers.set(placeKey, buf);
  };
  // Peek renders the buffer WITHOUT clearing and snapshots exactly which entries it consumed; the commit
  // (after the turn reaches the agent, which persists the prompt into the session) removes only those
  // entries by identity. So a pre-agent failure leaves them intact, AND a message that arrives during
  // the turn's attachment-download window (pushed to the same bucket, not in this prompt) survives for
  // the next answered turn — a whole-bucket delete would lose it.
  const bufferPeek = (placeKey: string): { text: string; consumed: BufferEntry[] } => {
    const buf = buffers.get(placeKey) ?? [];
    return { text: buf.map((e) => `${e.sender}: ${e.body}`).join("\n"), consumed: [...buf] };
  };
  const bufferCommit = (placeKey: string, consumed: BufferEntry[]): void => {
    const buf = buffers.get(placeKey);
    if (!buf) return;
    const remaining = buf.filter((e) => !consumed.includes(e));
    if (remaining.length === 0) buffers.delete(placeKey);
    else buffers.set(placeKey, remaining);
  };

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

    // Decide whether/where to answer, then stream the reply. ACK 200 immediately (the turn may outlast
    // the webhook timeout); lifecycle goes to stderr — after the 200 there is no response body, so those
    // lines are the operator's only signal. Concurrency: a per-session serial queue (FIFO) here; the
    // engine's per-session lease is the corruption floor beneath it.
    const m = pickMessage(update);
    if (!m) return new Response(null, { status: 200 });
    const placeKey = m.message_thread_id ? `${m.chat.id}:${m.message_thread_id}` : `${m.chat.id}`;
    const r = decide(update);
    if (!r) {
      // Not summoned: in a group, record the message so a later summon has the discussion (needs privacy
      // off to be delivered here at all). Empty/service messages and non-group chats keep no buffer.
      const isGroup = m.chat.type === "group" || m.chat.type === "supergroup";
      const content = messageText(m);
      if (isGroup && content) bufferPush(placeKey, fromLabel(m.from) ?? "someone", content);
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
      const target: Target = {
        chatId,
        threadId,
        replyTo: m.chat.type !== "private" && sameTarget ? m.message_id : undefined,
      };
      const baseText = r.text ?? telegramEnvelope(m, { botUsername: mentionName });
      const imageFileIds = extractImages(m);
      const fileIds = extractFiles(m);
      if (baseText.trim() !== "" || imageFileIds.length > 0 || fileIds.length > 0) {
        const turn = `${update.update_id}`;
        const where = `chat=${chatId}${target.threadId !== undefined ? ` thread=${target.threadId}` : ""}`;
        enqueueTurn(session, async () => {
          // Run at DEQUEUE time (serialized), so the lifecycle log and engine turn all reflect the actual
          // execution order rather than arrival. Fold the un-summoned discussion since the last
          // answered turn into the prompt, then clear it — it now lives in this turn's durable session.
          const startedAt = Date.now();
          log.info(`[telegram] turn start: turn=${turn} session=${session} ${where}`);
          const { text: recent, consumed } = bufferPeek(placeKey);
          const prompt = recent ? `[recent group discussion:\n${recent}\n]\n\n${baseText}` : baseText;
          try {
            await streamReply(
              invokeWithAttachments(agent, session, prompt, chatId, imageFileIds, fileIds, apiBaseUrl, botToken, () =>
                bufferCommit(placeKey, consumed),
              ),
              apiBaseUrl,
              botToken,
              target,
              formatError,
            );
            log.info(`[telegram] turn done: turn=${turn} session=${session} (${Date.now() - startedAt}ms)`);
          } catch (error) {
            log.error(
              `[telegram] turn failed: turn=${turn} session=${session} (${Date.now() - startedAt}ms): ${String(error)}`,
            );
          }
        });
      }
    }
    return new Response(null, { status: 200 });
  };
}
