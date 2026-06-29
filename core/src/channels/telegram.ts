/**
 * Telegram bot channel: verify the webhook secret token → decide via `route(update)` → run the turn →
 * stream the agent's reply back to the chat, ACK 200. Reply model A: the channel holds the bot token
 * and posts the reply itself (chat UX), unlike the github channel's fire-and-forget. No SDK — inbound
 * is a JSON POST, outbound is a `fetch` to the Bot API. The developer writes only `route` (policy); the
 * channel owns transport + format + attachments.
 *
 * Live streaming: tool calls + partial text stream into an ephemeral draft (sendMessageDraft, a 30s
 * animated preview); the final text is persisted with sendMessage. Threaded Mode (topics in private
 * chats, a @BotFather toggle) is auto-adapted: an update carrying message_thread_id replies into that
 * thread; without one the chat is linear. Same code, both modes.
 *
 * Authored against the public `@kid7st/fastagent` surface only (the contract + the channel-authoring
 * kit: readBodyCapped / text), so it is exactly what a third-party `fastagent-channel-*` package would write.
 */
import { timingSafeEqual } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { Agent, AgentEvent, ImageRef, Json } from "../agent.ts";
import { readBodyCapped } from "./body.ts";
import {
  type DownloadedFile,
  type Target,
  resolveBotUsername,
  resolveFiles,
  resolveImages,
  sendMessage,
  sendMessageDraft,
} from "./telegram-api.ts";
import { text } from "./respond.ts";

/** Update body cap — Telegram updates are small JSON; 1 MiB is generous and guards a public endpoint. */
const MAX_UPDATE_BYTES = 1 << 20;

/** How often (ms) to push a streamed draft update; tool events flush immediately for snappy feedback. */
const DRAFT_THROTTLE_MS = 800;

/** Re-push the draft at least this often, under Telegram's ~30s draft expiry, so a long step keeps the preview alive. */
const DRAFT_KEEPALIVE_MS = 20_000;

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

/** A Telegram message (the common subset; `[k]` keeps the rest reachable without a types dependency). */
export interface TelegramMessage {
  message_id: number;
  text?: string;
  /** Caption on a media message (photo/document/…) — often the user's instruction for the attachment. */
  caption?: string;
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
 * the agent never runs on inputs the user sent but we failed to load.
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
 * Consume one turn's event stream into a Telegram chat, live. Tool calls + partial text stream into an
 * ephemeral draft; the final text is persisted with sendMessage (the draft is a ~30s preview, so the
 * real message MUST be sent to keep it, and a keepalive re-pushes it so a long step does not blank it).
 * Draft updates are best-effort: they are only a preview, and the authoritative sendMessage surfaces
 * any real failure (bad token, etc.) — a client that does not support drafts degrades to "final only".
 */
async function streamReply(
  events: AsyncIterable<AgentEvent>,
  api: string,
  botToken: string,
  target: Target,
  draftId: number,
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
    // Before the first reasoning/tool/text arrives the draft is empty — Telegram renders an empty draft
    // as a bare "…", so show an explicit placeholder instead (this is also what the keepalive re-pushes).
    return v === "" ? "💭 Thinking…" : v;
  };
  // ── Live-preview pump: a SINGLE serialized writer. ──────────────────────────────────────────
  // Events mutate state (thinking / tools / answer) and mark the preview dirty; the pump sends the
  // LATEST view() with at most ONE sendMessageDraft in flight, paced by a throttle between sends, plus a
  // trailing send after the final change. One-in-flight is the whole point: concurrent draft sends (an
  // event update racing the keepalive, or a slow send overtaken by the next) can reach Telegram out of
  // order — an older frame landing over a newer one is the "shows 3-4 steps, blanks, re-fills" flicker.
  // Serializing through one writer keeps frames strictly monotonic; the keepalive marks dirty through
  // the same writer, so it cannot race.
  let dirty = false;
  let pumping = false;
  let stopped = false;
  let draftErrLogged = false;

  const runPump = async (): Promise<void> => {
    pumping = true;
    try {
      while (dirty && !stopped) {
        dirty = false;
        try {
          await sendMessageDraft(api, botToken, target, draftId, view());
        } catch (e) {
          // Best-effort preview (the final sendMessage is authoritative), but a failing draft must be
          // visible — log once per turn so a never-rendering draft is diagnosable, not silent.
          if (!draftErrLogged) {
            draftErrLogged = true;
            console.error(
              `[telegram] live draft failed (preview may not render; final reply still sends): ${String(e)}`,
            );
          }
        }
        if (dirty && !stopped) await sleep(DRAFT_THROTTLE_MS); // pace + coalesce a burst into one send
      }
    } finally {
      pumping = false;
    }
  };
  // Mark the preview dirty and ensure the single writer is running (a send already in flight picks up
  // the new state on its next loop). Synchronous — callers never await a network write.
  const touch = (): void => {
    dirty = true;
    if (!pumping) void runPump();
  };

  touch(); // show the "💭 Thinking…" placeholder immediately

  // A draft is a ~30s ephemeral preview; a long event-less step would let it lapse, so re-mark dirty on
  // a heartbeat to re-push the current view — through the same single writer, so no race.
  const keepalive = setInterval(touch, DRAFT_KEEPALIVE_MS);
  // Stop the writer (no draft frame after the authoritative final message); an in-flight send may land,
  // but the pump starts no new one once stopped.
  const finish = (): void => {
    stopped = true;
    clearInterval(keepalive);
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
        finish();
        if (answer.trim() !== "") await sendMessage(api, botToken, target, answer);
        return;
      } else if (e.type === "failed") {
        finish();
        // Two audiences: the chat (customer-facing — formatError, neutral by default) and the operator
        // log (dev-facing — the full details, via the throw below + the handler's catch).
        const msg = formatError({ details: e.details, retryable: e.retryable });
        if (msg && msg.trim() !== "") await sendMessage(api, botToken, target, msg).catch(() => {});
        throw new Error(`agent failed: ${e.details} (retryable=${e.retryable})`);
      }
    }
    throw new Error("stream ended without a terminal event"); // violates SPEC MUST 1
  } finally {
    finish();
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

/**
 * The default base prompt: a context envelope (chat/thread/sender + reply) then the user's text/caption
 * and a compact rendering of structured payloads (location/contact/poll). The sender is named on every
 * message — in a shared multi-user session that is how the model tells participants apart. The reply
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
  const replyTo = r
    ? `\n[in reply to ${fromLabel(r.from) ?? `msg ${r.message_id}`} (msg ${r.message_id}): ${(r.text ?? r.caption ?? attachmentSummary(r) ?? "(empty)").slice(0, 280)}]`
    : "";
  const parts = [m.text ?? m.caption ?? attachmentSummary(m) ?? ""];
  if (m.location) parts.push(`[location: ${m.location.latitude},${m.location.longitude}]`);
  if (m.contact) parts.push(`[contact: ${m.contact.first_name} ${m.contact.phone_number ?? ""}]`);
  if (m.poll) parts.push(`[poll: ${m.poll.question} — ${(m.poll.options ?? []).map((o) => o.text).join(" / ")}]`);
  return `[telegram: ${meta}]${replyTo}\n${parts.filter(Boolean).join("\n")}`;
}

/**
 * The default routing policy (used when `route` is omitted; exported so a custom route can reuse it):
 * answer private chats always, groups only on a command, a reply to the bot, or an @mention (when
 * `botUsername` is supplied — telegramChannel resolves it via getMe). Returns `{}` (act; the channel
 * fills session/target/prompt from the message) or `null` (ignore).
 */
export function defaultTelegramRoute(update: TelegramUpdate, options?: { botUsername?: string }): TelegramRoute | null {
  const m = pickMessage(update);
  if (!m) return null;
  const t = m.text ?? "";
  const summoned =
    m.chat.type === "private" ||
    t.startsWith("/") ||
    m.reply_to_message?.from?.is_bot === true ||
    (options?.botUsername ? t.includes(`@${options.botUsername}`) : false);
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
  // The default route summons on a group @mention, which needs the bot's own @username; resolve it once
  // via getMe (only when using the default route and not supplied). A custom route owns its own summon.
  let mentionName = botUsername;
  if (!route && !botUsername) {
    void resolveBotUsername(apiBaseUrl, botToken).then(
      (u) => {
        mentionName = u;
      },
      (e) => console.error(`[telegram] getMe failed; group @mention summon disabled: ${String(e)}`),
    );
  }
  const decide = route ?? ((update: TelegramUpdate) => defaultTelegramRoute(update, { botUsername: mentionName }));
  let draftSeq = 0; // non-zero, per-turn draft ids (process-lived; the route handler is built once)
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
    // lines are the operator's only signal. Concurrency safety = the engine's per-session lease.
    const m = pickMessage(update);
    const r = m ? decide(update) : null;
    if (m && r) {
      const session = r.session ?? (m.message_thread_id ? `${m.chat.id}:${m.message_thread_id}` : `${m.chat.id}`);
      const chatId = r.chatId ?? m.chat.id;
      const target: Target = { chatId, threadId: r.threadId ?? m.message_thread_id };
      const baseText = r.text ?? telegramEnvelope(m);
      const imageFileIds = extractImages(m);
      const fileIds = extractFiles(m);
      if (baseText.trim() !== "" || imageFileIds.length > 0 || fileIds.length > 0) {
        draftSeq = (draftSeq % 1_000_000_000) + 1;
        const draftId = draftSeq;
        const turn = `${update.update_id}`;
        const where = `chat=${chatId}${target.threadId !== undefined ? ` thread=${target.threadId}` : ""}`;
        console.error(`[telegram] turn start: turn=${turn} session=${session} ${where}`);
        const startedAt = Date.now();
        void streamReply(
          invokeWithAttachments(agent, session, baseText, chatId, imageFileIds, fileIds, apiBaseUrl, botToken),
          apiBaseUrl,
          botToken,
          target,
          draftId,
          formatError,
        ).then(
          () => console.error(`[telegram] turn done: turn=${turn} session=${session} (${Date.now() - startedAt}ms)`),
          (error) =>
            console.error(
              `[telegram] turn failed: turn=${turn} session=${session} (${Date.now() - startedAt}ms): ${String(error)}`,
            ),
        );
      }
    }
    return new Response(null, { status: 200 });
  };
}
