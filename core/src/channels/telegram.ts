/**
 * Telegram bot channel: verify the webhook secret token → route via `on(update)` → run the turn →
 * stream the agent's reply back to the chat, ACK 200. Reply model A: the channel holds the bot token
 * and posts the reply itself (chat UX), unlike the github channel's fire-and-forget. No SDK — inbound
 * is a JSON POST, outbound is a `fetch` to the Bot API. The developer writes only `on`.
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
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Agent, AgentEvent, ImageRef, Json } from "../agent.ts";
import { readBodyCapped } from "./body.ts";
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
  /** Photo sizes, smallest → largest. Pass the last one's `file_id` as an intent image for vision. */
  photo?: { file_id: string; file_unique_id: string; width: number; height: number; file_size?: number }[];
  /** Structured payloads worth rendering into the prompt as text (no new modality needed). */
  location?: { latitude: number; longitude: number; [k: string]: unknown };
  contact?: { phone_number?: string; first_name: string; last_name?: string; [k: string]: unknown };
  poll?: { question: string; options?: { text: string }[]; [k: string]: unknown };
  /** Files (downloaded to disk by the channel when listed in an intent's `fileIds`). */
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

/** What `on` returns per acted-on update: a session + the prompt + where (chat, optionally thread) to reply. */
export interface TelegramIntent {
  session: string;
  text: string;
  /** Chat the agent's reply is sent to (usually `update.message.chat.id`). */
  chatId: number | string;
  /** Thread to reply into (Threaded Mode); omit for a linear chat. Usually `update.message.message_thread_id`. */
  threadId?: number;
  /** Telegram file_ids to fetch and pass to the agent as images (e.g. the largest `message.photo` size). */
  imageFileIds?: string[];
  /** Telegram file_ids (document/voice/video/…) to download to disk; the agent reads them with its tools. */
  fileIds?: string[];
}

export interface TelegramChannelOptions {
  /** Webhook secret token (the `secret_token` you set via setWebhook); verifies inbound updates. */
  secretToken: string;
  /** Bot token — used to send the agent's reply via the Bot API. */
  botToken: string;
  /** Telegram parse mode for bot replies. Omit for plain text. */
  parseMode?: "Markdown" | "MarkdownV2" | "HTML";
  /** Map a verified update to the intents this agent acts on (empty array = ignore). Defaults to {@link defaultTelegramOn}. */
  on?: (update: TelegramUpdate) => TelegramIntent[];
  /**
   * Customer-facing failure text for the chat (the dev-facing full `details` always go to the operator
   * log). Return a string to send it, or undefined/"" to stay silent. Default: a neutral message keyed
   * on `retryable`. A developer's own bot can surface the raw details, e.g. `(f) => `⚠️ ${f.details}``.
   */
  onError?: (failed: TelegramFailure) => string | undefined;
  /** Bot API base, for tests. Defaults to the public Telegram endpoint. */
  apiBaseUrl?: string;
}

/** Where a reply goes: a chat, optionally a thread (Threaded Mode). */
interface Target {
  chatId: number | string;
  threadId?: number;
}

/** Constant-time compare so the secret-token check leaks no timing signal. */
function tokenMatches(header: string, secret: string): boolean {
  const a = Buffer.from(header);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Telegram's hard text limit per message. */
const TELEGRAM_MAX_TEXT = 4096;
const PARSE_ERROR = /can't parse|entit|unsupported|unclosed|tag/i;

/** One Bot API call, retrying on a 429 with the server's `retry_after` (a few attempts). */
async function callBotApi(
  api: string,
  botToken: string,
  method: string,
  params: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; status: number; description: string }> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${api}/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    if (res.ok) return { ok: true };
    const data = (await res.json().catch(() => ({}))) as { description?: string; parameters?: { retry_after?: number } };
    const retryAfter = data.parameters?.retry_after;
    if (res.status === 429 && retryAfter !== undefined && attempt < 3) {
      await sleep((retryAfter + 1) * 1000);
      continue;
    }
    return { ok: false, status: res.status, description: data.description ?? "" };
  }
}

/** Split text into ≤4096-char chunks (Telegram's limit), preferring newline boundaries. */
function chunkText(text: string): string[] {
  if (text.length <= TELEGRAM_MAX_TEXT) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > TELEGRAM_MAX_TEXT) {
    const nl = rest.lastIndexOf("\n", TELEGRAM_MAX_TEXT);
    const cut = nl > 0 ? nl : TELEGRAM_MAX_TEXT;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest !== "") chunks.push(rest);
  return chunks;
}

/**
 * Persist a final reply: split to Telegram's 4096-char limit, and for each chunk try the requested
 * parse_mode, then Markdown, then plain — a formatting slip (the model's HTML/markdown not matching
 * Telegram's parser) degrades gracefully instead of losing the message. `message_thread_id` is dropped
 * from the JSON when undefined (linear chat).
 */
async function sendMessage(
  api: string,
  botToken: string,
  t: Target,
  body: string,
  parseMode?: TelegramChannelOptions["parseMode"],
): Promise<void> {
  const modes: (TelegramChannelOptions["parseMode"] | undefined)[] =
    parseMode === "HTML" ? ["HTML", "Markdown", undefined] : parseMode ? [parseMode, undefined] : [undefined];
  for (const chunk of chunkText(body)) {
    let result: Awaited<ReturnType<typeof callBotApi>> = { ok: false, status: 0, description: "" };
    for (const mode of modes) {
      result = await callBotApi(api, botToken, "sendMessage", {
        chat_id: t.chatId,
        message_thread_id: t.threadId,
        text: chunk,
        parse_mode: mode,
      });
      if (result.ok || !PARSE_ERROR.test(result.description)) break; // re-format only on a parse error
    }
    if (!result.ok) throw new Error(`telegram sendMessage failed: ${result.status} ${result.description}`.trim());
  }
}

/** Push an ephemeral draft (animated preview, capped at the text limit). Same draft_id animates updates. */
async function sendMessageDraft(api: string, botToken: string, t: Target, draftId: number, body: string): Promise<void> {
  const result = await callBotApi(api, botToken, "sendMessageDraft", {
    chat_id: t.chatId,
    message_thread_id: t.threadId,
    draft_id: draftId,
    text: body.slice(0, TELEGRAM_MAX_TEXT),
  });
  if (!result.ok) throw new Error(`telegram sendMessageDraft failed: ${result.status} ${result.description}`.trim());
}

/** Download sanity cap (Telegram's own getFile limit); a larger file/image is rejected visibly. The
 *  engine resizes images to the model's needs, so this is a transport guard, not the model size limit. */
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

/** Where inbound files land (under the workspace's .fastagent machine-state dir; the agent reads them by path). */
const FILES_SUBDIR = join(".fastagent", "telegram-files");

function mimeFromPath(path: string): string {
  const ext = path.toLowerCase().split(".").pop();
  return ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/jpeg";
}

/** Resolve a Telegram file_id to an ImageRef (getFile → download → base64). Throws on failure / oversize. */
async function fetchTelegramImage(api: string, botToken: string, fileId: string): Promise<ImageRef> {
  const meta = (await fetch(`${api}/bot${botToken}/getFile`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  }).then((r) => r.json())) as { ok?: boolean; result?: { file_path?: string; file_size?: number } };
  const path = meta.result?.file_path;
  if (!meta.ok || !path) throw new Error(`getFile failed for ${fileId}`);
  if ((meta.result?.file_size ?? 0) > MAX_DOWNLOAD_BYTES) throw new Error("image is too large (max 20 MB)");
  const res = await fetch(`${api}/file/bot${botToken}/${path}`);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.byteLength > MAX_DOWNLOAD_BYTES) throw new Error("image is too large (max 20 MB)");
  return { mimeType: mimeFromPath(path), data: bytes.toString("base64") };
}

/** A downloaded inbound file: an absolute local path the agent's tools (read/bash) can open. */
interface DownloadedFile {
  path: string;
  name: string;
  size: number;
}

/** Download a Telegram file_id to <cwd>/.fastagent/telegram-files/<chat>/<name>. Throws on failure / oversize. */
async function downloadTelegramFile(
  api: string,
  botToken: string,
  fileId: string,
  chatId: number | string,
): Promise<DownloadedFile> {
  const meta = (await fetch(`${api}/bot${botToken}/getFile`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  }).then((r) => r.json())) as { ok?: boolean; result?: { file_path?: string; file_size?: number } };
  const remote = meta.result?.file_path;
  if (!meta.ok || !remote) throw new Error(`getFile failed for ${fileId}`);
  if ((meta.result?.file_size ?? 0) > MAX_DOWNLOAD_BYTES) throw new Error("file is too large (max 20 MB)");
  const res = await fetch(`${api}/file/bot${botToken}/${remote}`);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.byteLength > MAX_DOWNLOAD_BYTES) throw new Error("file is too large (max 20 MB)");
  const name = basename(remote);
  const dir = join(process.cwd(), FILES_SUBDIR, String(chatId));
  await mkdir(dir, { recursive: true });
  const dest = join(dir, name);
  await writeFile(dest, bytes);
  return { path: dest, name, size: bytes.byteLength };
}

/** Download all of an intent's files. Throws if any cannot be loaded — the caller surfaces it (no silent drop). */
async function resolveFiles(
  api: string,
  botToken: string,
  fileIds: string[] | undefined,
  chatId: number | string,
): Promise<DownloadedFile[] | undefined> {
  if (!fileIds || fileIds.length === 0) return undefined;
  const files: DownloadedFile[] = [];
  for (const id of fileIds) files.push(await downloadTelegramFile(api, botToken, id, chatId));
  return files;
}

/** Fetch all of an intent's images. Throws if any cannot be loaded — the caller surfaces it (no silent drop). */
async function resolveImages(
  api: string,
  botToken: string,
  fileIds: string[] | undefined,
): Promise<ImageRef[] | undefined> {
  if (!fileIds || fileIds.length === 0) return undefined;
  const images: ImageRef[] = [];
  for (const id of fileIds) images.push(await fetchTelegramImage(api, botToken, id));
  return images;
}

/**
 * agent.invoke, but resolve the intent's attachments first: images (vision) inline, and files
 * downloaded to disk with their absolute paths appended to the prompt so the agent can read them with
 * its tools. A transport failure becomes a `failed` event — surfaced (user + log), never a silent drop;
 * the agent never runs on inputs the user sent but we failed to load.
 */
/** Appended to the prompt (not the system prompt) when parseMode is HTML: ask the model for Telegram HTML. */
const HTML_INSTRUCTION =
  "\n\n(Format your reply in Telegram-supported HTML — <b> <i> <u> <s> <code> <pre> <a href> — not Markdown.)";

async function* invokeWithAttachments(
  agent: Agent,
  session: string,
  text: string,
  chatId: number | string,
  imageFileIds: string[] | undefined,
  fileIds: string[] | undefined,
  api: string,
  botToken: string,
  parseMode?: TelegramChannelOptions["parseMode"],
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
  const format = parseMode === "HTML" ? HTML_INSTRUCTION : "";
  yield* agent.invoke({ session }, { text: text + manifest + format, images });
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
  parseMode?: TelegramChannelOptions["parseMode"],
): Promise<void> {
  const tools: { label: string; status: "running" | "ok" | "error" }[] = [];
  const toolIndexById = new Map<string, number>();
  let thinking = "";
  let answer = "";
  let lastDraftAt = 0;
  let draftErrLogged = false;

  const mark = { running: "…", ok: "✓", error: "✗" } as const;
  const toolView = (): string => tools.map((t) => `🔧 ${t.label} ${mark[t.status]}`).join("\n");
  // Reasoning is process, not the answer: shown (capped to its tail) in the live preview only, never
  // in the persisted final message (which is `answer` alone).
  const thinkingView = (): string => {
    const t = thinking.replace(/\s+/g, " ").trim();
    if (t === "") return "";
    return `💭 ${t.length > THINKING_PREVIEW ? `…${t.slice(t.length - THINKING_PREVIEW + 1)}` : t}`;
  };
  const view = (): string =>
    [thinkingView(), toolView(), answer]
      .filter((s) => s.trim() !== "")
      .join("\n\n")
      .trim();
  const draft = async (force: boolean): Promise<void> => {
    if (!force && Date.now() - lastDraftAt < DRAFT_THROTTLE_MS) return;
    lastDraftAt = Date.now();
    try {
      await sendMessageDraft(api, botToken, target, draftId, view());
    } catch (e) {
      // The live preview is best-effort (the final sendMessage is authoritative), but a failing draft
      // must be visible — log it once per turn so a draft that never renders is diagnosable, not silent.
      if (!draftErrLogged) {
        draftErrLogged = true;
        console.error(`[telegram] live draft failed (preview may not render; final reply still sends): ${String(e)}`);
      }
    }
  };

  await draft(true); // empty view → Telegram shows a "Thinking…" placeholder immediately

  // A draft is a ~30s ephemeral preview; a long tool / arg-generation step emits no events, so without
  // a heartbeat the preview lapses and the chat looks dead. Re-push the current view to keep it alive.
  const keepalive = setInterval(() => void draft(true), DRAFT_KEEPALIVE_MS);
  try {
    for await (const e of events) {
      if (e.type === "text") {
        answer += e.delta;
        await draft(false);
      } else if (e.type === "thinking") {
        thinking += e.delta;
        await draft(false);
      } else if (e.type === "tool_started") {
        const arg = summarizeArgs(e.args);
        toolIndexById.set(e.id, tools.length);
        tools.push({ label: arg ? `${e.name} ${arg}` : e.name, status: "running" });
        await draft(true);
      } else if (e.type === "tool_ended") {
        const i = toolIndexById.get(e.id);
        const t = i === undefined ? undefined : tools[i];
        if (t) t.status = e.isError ? "error" : "ok";
        await draft(true);
      } else if (e.type === "completed") {
        clearInterval(keepalive);
        if (answer.trim() !== "") await sendMessage(api, botToken, target, answer, parseMode);
        return;
      } else if (e.type === "failed") {
        clearInterval(keepalive);
        // Two audiences: the chat (customer-facing — formatError, neutral by default) and the operator
        // log (dev-facing — the full details, via the throw below + the handler's catch).
        const msg = formatError({ details: e.details, retryable: e.retryable });
        if (msg && msg.trim() !== "") await sendMessage(api, botToken, target, msg, parseMode).catch(() => {});
        throw new Error(`agent failed: ${e.details} (retryable=${e.retryable})`);
      }
    }
    throw new Error("stream ended without a terminal event"); // violates SPEC MUST 1
  } finally {
    clearInterval(keepalive);
  }
}

/**
 * Default update→intents routing (used when `on` is omitted; exported so a custom `on` can build on it):
 * routes message/edited_message/channel_post/edited_channel_post; text/caption + structured payloads
 * (location/contact/poll) as text; photo→image, document/voice/video/audio→file; reply context; a
 * metadata envelope; per-thread session; and a group-summon gate — private chats always pass, groups
 * only on a command or a reply to the bot (@mention needs your bot's username, so write your own `on`).
 */
export function defaultTelegramOn(update: TelegramUpdate): TelegramIntent[] {
  const m = update.message ?? update.edited_message ?? update.channel_post ?? update.edited_channel_post;
  if (!m) return [];
  const r = m.reply_to_message;
  const t = m.text ?? "";
  const cmd = t.startsWith("/") ? t.slice(1).split(" ")[0]?.split("@")[0] : undefined;
  if (!(m.chat.type === "private" || Boolean(cmd) || r?.from?.is_bot === true)) return []; // group summon
  const parts = [m.text ?? m.caption ?? ""];
  if (m.location) parts.push(`[location: ${m.location.latitude},${m.location.longitude}]`);
  if (m.contact) parts.push(`[contact: ${m.contact.first_name} ${m.contact.phone_number ?? ""}]`);
  if (m.poll) parts.push(`[poll: ${m.poll.question} — ${(m.poll.options ?? []).map((o) => o.text).join(" / ")}]`);
  const body = parts.filter(Boolean).join("\n");
  const imageFileIds = [m.photo?.at(-1)?.file_id, r?.photo?.at(-1)?.file_id].filter((id): id is string => Boolean(id));
  const fileIds = [m.document?.file_id, m.voice?.file_id, m.video?.file_id, m.audio?.file_id].filter(
    (id): id is string => Boolean(id),
  );
  if (!body && imageFileIds.length === 0 && fileIds.length === 0) return [];
  const session = m.message_thread_id ? `${m.chat.id}:${m.message_thread_id}` : `${m.chat.id}`;
  const meta = [
    `chat ${m.chat.id} (${m.chat.type})`,
    m.message_thread_id ? `thread ${m.message_thread_id}` : undefined,
    m.from?.username ? `from @${m.from.username}` : undefined,
  ]
    .filter(Boolean)
    .join(", ");
  const replyTo = r
    ? `\n[reply to ${r.from?.username ? `@${r.from.username}` : `msg ${r.message_id}`}: ${(r.text ?? r.caption ?? "(media)").slice(0, 200)}]`
    : "";
  return [
    {
      session,
      text: `[telegram: ${meta}]${replyTo}\n${body}`,
      chatId: m.chat.id,
      threadId: m.message_thread_id,
      imageFileIds: imageFileIds.length ? imageFileIds : undefined,
      fileIds: fileIds.length ? fileIds : undefined,
    },
  ];
}

/** Build a Telegram bot channel for `agent`: a Fetch handler to mount at your webhook route (POST). */
export function telegramChannel(
  agent: Agent,
  { secretToken, botToken, parseMode, on, onError, apiBaseUrl = "https://api.telegram.org" }: TelegramChannelOptions,
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
  const route = on ?? defaultTelegramOn;
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

    // Run each intent and stream the reply, ACK 200 immediately (the turn may outlast the webhook
    // timeout). The lifecycle is logged to stderr — after the 200 there is no response body, so these
    // lines are the operator's only signal. Concurrency safety = the engine's per-session lease.
    const intents = route(update);
    for (let i = 0; i < intents.length; i++) {
      const intent = intents[i] as TelegramIntent;
      const target: Target = { chatId: intent.chatId, threadId: intent.threadId };
      draftSeq = (draftSeq % 1_000_000_000) + 1;
      const draftId = draftSeq;
      const turn = `${update.update_id}#${i}`;
      const where = `chat=${intent.chatId}${intent.threadId !== undefined ? ` thread=${intent.threadId}` : ""}`;
      console.error(`[telegram] turn start: turn=${turn} session=${intent.session} ${where}`);
      const startedAt = Date.now();
      // Images are resolved lazily inside invokeWithImages (post-ACK): on() chose the file_ids, the
      // channel owns the transport (bot token + file API) that on()'s synchronous map cannot do.
      void streamReply(
        invokeWithAttachments(
          agent,
          intent.session,
          intent.text,
          intent.chatId,
          intent.imageFileIds,
          intent.fileIds,
          apiBaseUrl,
          botToken,
          parseMode,
        ),
        apiBaseUrl,
        botToken,
        target,
        draftId,
        formatError,
        parseMode,
      ).then(
        () =>
          console.error(`[telegram] turn done: turn=${turn} session=${intent.session} (${Date.now() - startedAt}ms)`),
        (error) =>
          console.error(
            `[telegram] turn failed: turn=${turn} session=${intent.session} (${Date.now() - startedAt}ms): ${String(error)}`,
          ),
      );
    }
    return new Response(null, { status: 200 });
  };
}
