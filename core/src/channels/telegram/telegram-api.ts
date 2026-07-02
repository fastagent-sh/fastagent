/**
 * Telegram Bot API transport. ONE pipeline (`callApi`) carries every JSON call — per-method code does
 * not exist, so a transport rule can never be missing from one call site. The transport invariants
 * live here and nowhere else:
 *
 *  1. Every call has a per-attempt timeout (API_TIMEOUT_MS; file bytes DOWNLOAD_TIMEOUT_MS) — a wedged
 *     connection cannot hang a turn, its session queue, or webhook registration.
 *  2. Only a 429 is retried (bounded attempts, honouring `retry_after` up to FLOOD_WAIT_MAX_S per
 *     wait); a longer flood ban or exhausted retries fail visibly. No other failure class is retried:
 *     the request may have been processed, and a retried sendMessage would double-deliver.
 *  3. Success requires the body's own `ok:true` — an intermediary's HTTP 200 is not a sent message.
 *  4. Every failure is a {@link TelegramApiError} naming the method: self-description is a property of
 *     the error type, not per-call-site string assembly.
 *
 * On top of the pipeline sits the channel's POLICY: the 4096-char HTML-aware split, the HTML→plain
 * parse fallback, and the getFile→download dance. (telegram.ts orchestrates; no agent, no rendering.)
 */
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ImageRef } from "../../agent.ts";

/** Telegram's hard text limit per message. */
export const TELEGRAM_MAX_TEXT = 4096;
const PARSE_ERROR = /can't parse|entit|unsupported|unclosed|tag/i;

/** Per-attempt timeout for a JSON Bot API call — small JSON round-trips, so 30s is generous. */
const API_TIMEOUT_MS = 30_000;

/** Timeout for downloading file bytes (up to the 20 MB cap) — sized for a slow link, not a JSON call. */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** Longest flood wait (seconds) honoured PER ATTEMPT before failing visibly instead. Telegram's
 *  `retry_after` can reach minutes–hours on a flood ban; sleeping that long would silently park the
 *  turn and every queued turn behind it. Aggregate is bounded by RETRIES: ~3× this cap worst-case. */
const FLOOD_WAIT_MAX_S = 30;

/** How many 429s one call absorbs before giving up. */
const RETRIES = 3;

/** Download sanity cap (Telegram's own getFile limit); a larger file/image is rejected visibly. The
 *  engine resizes images to the model's needs, so this is a transport guard, not the model size limit. */
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

/** Where inbound files land (the agent reads them by path). Machine state under `.fastagent`: persists,
 *  not auto-cleaned (like sessions) — a long-running bot's operator manages the dir. Git-ignored via
 *  `<dir>/.fastagent/.gitignore="*"`, which dev/start write when self-ignoring the state dir (the
 *  default; NOT registered with that guard, so an all-external sessions+auth config leaves it tracked). */
const FILES_SUBDIR = join(".fastagent", "telegram-files");

/** Where a reply goes: a chat, optionally a thread (Threaded Mode), optionally replying to a message. */
export interface Target {
  chatId: number | string;
  threadId?: number;
  /** Message to reply to (the summoning message). Set in groups so the answer threads under the asker. */
  replyTo?: number;
}

/** A downloaded inbound file: an absolute local path the agent's tools (read/bash) can open. */
export interface DownloadedFile {
  path: string;
  name: string;
  size: number;
}

/** The methods this channel speaks and their result shapes — a hand-written slice of the Bot API
 *  schema. Adding a method = adding a row here, not writing a function. (If this table ever needs to
 *  grow past roughly ten rows, or entity-based formatting, adopt gramIO instead of growing it.) */
interface Api {
  sendMessage: { message_id?: number };
  editMessageText: unknown;
  deleteMessage: unknown;
  getMe: { username?: string; can_read_all_group_messages?: boolean };
  getFile: { file_path?: string; file_size?: number };
  setWebhook: unknown;
}

/** A named Bot API failure. `status` 0 = the transport itself failed (network error / timeout) before
 *  any HTTP status existed; otherwise the HTTP status with Telegram's own description (or a note that
 *  the body carried no usable answer). */
export class TelegramApiError extends Error {
  readonly method: string;
  readonly status: number;
  readonly description: string;
  // No constructor parameter properties: the CLI runs source under Node's strip-only TS mode, which
  // rejects them (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX).
  constructor(method: string, status: number, description: string, options?: { cause?: unknown }) {
    super(
      status === 0
        ? `telegram ${method}: ${description}`
        : `telegram ${method} failed: ${status} ${description}`.trim(),
      options,
    );
    this.name = "TelegramApiError";
    this.method = method;
    this.status = status;
    this.description = description;
  }
}

/** Sleep on the GLOBAL timer (not `node:timers/promises`) so tests can drive it with fake timers. */
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The pipeline: one Bot API call, carrying every transport invariant (see the module header). Returns
 * the method's `result` payload; throws {@link TelegramApiError} on any failure.
 */
export async function callApi<M extends keyof Api>(
  api: string,
  botToken: string,
  method: M,
  params: Record<string, unknown>,
): Promise<Api[M]> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    let raw: string;
    try {
      res = await fetch(`${api}/bot${botToken}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      raw = await res.text(); // the body read shares the timeout — a mid-body stall is a transport failure too
    } catch (e) {
      throw new TelegramApiError(method, 0, String(e), { cause: e });
    }
    let data: { ok?: boolean; result?: unknown; description?: string; parameters?: { retry_after?: number } };
    try {
      data = JSON.parse(raw) as typeof data;
    } catch {
      data = {}; // only the parse is forgiven — the ok-gate below turns it into a named failure
    }
    if (res.ok && data.ok === true) return data.result as Api[M];
    if (res.status === 429 && attempt < RETRIES) {
      const floodWait = data.parameters?.retry_after ?? attempt + 1; // no retry_after → short linear backoff
      if (floodWait <= FLOOD_WAIT_MAX_S) {
        await wait((floodWait + 1) * 1000);
        continue;
      }
      throw new TelegramApiError(
        method,
        429,
        `${data.description ?? ""} (retry_after ${floodWait}s exceeds the ${FLOOD_WAIT_MAX_S}s flood-wait cap)`.trim(),
      );
    }
    const exhausted = res.status === 429 ? ` (gave up after ${attempt} retries)` : "";
    throw new TelegramApiError(
      method,
      res.status,
      `${data.description ?? "Bot API response was not the expected JSON"}${exhausted}`.trim(),
    );
  }
}

/** Tags left open at the end of `html`, innermost last, each as its full opening string (attributes and
 *  all) so a reopen reproduces `<a href=…>` / `<code class=…>` exactly. A close pops the nearest matching
 *  open. Telegram's HTML is a shallow flat subset, so this simple stack is enough. */
function unclosedTags(html: string): { name: string; open: string }[] {
  const stack: { name: string; open: string }[] = [];
  for (const m of html.matchAll(/<(\/?)([a-z][a-z0-9-]*)(?:\s[^>]*)?>/gi)) {
    const name = m[2]?.toLowerCase();
    if (name === undefined) continue;
    if (m[1] === "/") {
      const i = stack.map((t) => t.name).lastIndexOf(name);
      if (i !== -1) stack.splice(i, 1);
    } else {
      stack.push({ name, open: m[0] });
    }
  }
  return stack;
}

/** Reserve for the `</…>` closers appended at a chunk boundary — Telegram nesting is shallow, so this
 *  covers the worst realistic stack. A pathological deeper nest would push the chunk past 4096 and fail
 *  visibly on send (Telegram's "message is too long", not a silent truncation); real agent output does
 *  not reach it. */
const TAG_CLOSE_BUDGET = 64;

/**
 * Split text into ≤4096-char chunks (Telegram's limit), preferring a newline boundary. When `html`, it is
 * tag-aware: a tag that would SPAN a boundary is CLOSED at the chunk's end and REOPENED (attributes and
 * all) at the next chunk's start, so every chunk is self-contained valid HTML — a long `<pre>` code block
 * stays formatted instead of the first chunk degrading to plain text. It also never cuts THROUGH a tag
 * token (backs the cut up before a `<` it would land inside). For plain text a `<` is literal content, so
 * both behaviours are skipped.
 */
export function chunkText(text: string, opts: { html?: boolean } = {}): string[] {
  if (text.length <= TELEGRAM_MAX_TEXT) return [text];
  const chunks: string[] = [];
  let open: { name: string; open: string }[] = []; // tags carried across the current boundary (html only)
  let rest = text;
  while (rest.length > 0) {
    const prefix = open.map((t) => t.open).join(""); // reopen carried tags at the chunk head
    if (prefix.length + rest.length <= TELEGRAM_MAX_TEXT) {
      chunks.push(prefix + rest); // the tail closes the carried tags itself
      break;
    }
    // Room for content, reserving the reopen prefix + (html) the closers appended below. ≥1 guarantees
    // progress even in a pathological deep nest.
    const room = Math.max(1, TELEGRAM_MAX_TEXT - prefix.length - (opts.html ? TAG_CLOSE_BUDGET : 0));
    let cut = rest.lastIndexOf("\n", room);
    if (cut <= 0) cut = room; // no newline in range → hard cut at the limit
    if (opts.html) {
      // Don't cut through a tag token: if the last `<` before the cut has no `>` after it, back up to it
      // (lt > 0 keeps at least one content char, so the loop still progresses).
      const lt = rest.lastIndexOf("<", cut - 1);
      if (lt > 0 && lt > rest.lastIndexOf(">", cut - 1)) cut = lt;
      // Likewise don't split an entity token (`&amp;`): entities are short, so a `&` within ~12 chars of
      // the cut with no `;` yet means the cut is inside one — back up to that `&`. Only when the `&` is
      // CONTENT, not inside a tag token (a raw `&` in an attribute is legal and common — any href with
      // query params); backing up to one of those would cut through the tag this very rule's sibling
      // protects.
      const amp = rest.lastIndexOf("&", cut - 1);
      if (
        amp > 0 &&
        cut - amp < 12 &&
        amp > rest.lastIndexOf(";", cut - 1) &&
        rest.lastIndexOf("<", amp) <= rest.lastIndexOf(">", amp)
      )
        cut = amp;
    }
    let chunk = rest.slice(0, cut);
    let advance = cut;
    if (opts.html) {
      // A boundary newline is CONTENT in html (it may sit inside a <pre>) — keep it at this chunk's end
      // (before the closers) rather than dropping it, so rejoined <pre> code is lossless.
      if (rest[cut] === "\n") {
        chunk += "\n";
        advance = cut + 1;
      }
      open = unclosedTags(prefix + chunk);
      chunk += open
        .map((t) => `</${t.name}>`)
        .reverse()
        .join("");
    }
    chunks.push(prefix + chunk);
    // Plain text: drop the boundary newline (the message split itself separates the parts). Html: keep
    // everything (the newline was already folded into the chunk above).
    rest = opts.html ? rest.slice(advance) : rest.slice(cut).replace(/^\n/, "");
  }
  return chunks;
}

/**
 * Send a message: split to Telegram's 4096-char limit, each chunk as HTML by default (`html:false` for a
 * plain live-preview). If Telegram rejects the markup on the FIRST chunk (a model formatting slip), the
 * whole body is re-chunked and resent as PLAIN — re-chunked, not the same bytes, so the tag-balancer's
 * injected boundary tags don't leak as literal text. (A later chunk failing after the first parsed
 * cleanly is rare; it falls back per-chunk, best-effort.) Returns the FIRST chunk's message_id (so the
 * caller can edit it as a live preview). `message_thread_id` is dropped from the JSON when undefined.
 */
export async function sendMessage(
  api: string,
  botToken: string,
  t: Target,
  body: string,
  opts: { html?: boolean } = {},
): Promise<number | undefined> {
  let mode = opts.html ?? true;
  let chunks = chunkText(body, { html: mode });
  let firstId: number | undefined;
  let first = true;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk === undefined) continue;
    const base: Record<string, unknown> = { chat_id: t.chatId, message_thread_id: t.threadId, text: chunk };
    // Reply to the summoning message on the FIRST chunk only — threads the answer under the asker in a
    // group; allow_sending_without_reply so a since-deleted original still delivers. Continuation
    // chunks post plainly right after (N reply-quotes would be noise).
    if (first && t.replyTo !== undefined) {
      base.reply_parameters = { message_id: t.replyTo, allow_sending_without_reply: true };
    }
    let result: Api["sendMessage"];
    try {
      result = await callApi(api, botToken, "sendMessage", mode ? { ...base, parse_mode: "HTML" } : base);
    } catch (e) {
      if (!(mode && e instanceof TelegramApiError && PARSE_ERROR.test(e.description))) throw e;
      if (first) {
        // Nothing sent yet — re-chunk the whole body as plain (no injected boundary tags leak) and restart.
        mode = false;
        chunks = chunkText(body, { html: false });
        i = -1;
        continue;
      }
      // A later chunk failed after the first parsed cleanly (rare) — best-effort plain resend of this chunk.
      result = await callApi(api, botToken, "sendMessage", base);
    }
    if (first) firstId = result.message_id;
    first = false;
  }
  return firstId;
}

/**
 * Edit a message in place — the live-preview mechanism (one message, repeatedly updated). Plain by
 * default (a partial preview may contain unbalanced HTML); `html:true` for the final answer, falling
 * back to plain if Telegram rejects the markup. "message is not modified" is NOT an error: the pump may
 * re-render an unchanged view. The message is identified by (chat_id, message_id) — no thread needed.
 */
export async function editMessageText(
  api: string,
  botToken: string,
  t: Target,
  messageId: number,
  body: string,
  opts: { html?: boolean } = {},
): Promise<void> {
  const base: Record<string, unknown> = {
    chat_id: t.chatId,
    message_id: messageId,
    text: body.slice(0, TELEGRAM_MAX_TEXT),
  };
  const notModified = (e: unknown): boolean =>
    e instanceof TelegramApiError && /message is not modified/i.test(e.description);
  try {
    await callApi(api, botToken, "editMessageText", opts.html ? { ...base, parse_mode: "HTML" } : base);
  } catch (e) {
    if (notModified(e)) return;
    if (!(opts.html && e instanceof TelegramApiError && PARSE_ERROR.test(e.description))) throw e;
    try {
      await callApi(api, botToken, "editMessageText", base); // plain fallback for rejected markup
    } catch (e2) {
      if (!notModified(e2)) throw e2;
    }
  }
}

function mimeFromPath(path: string): string {
  const ext = path.toLowerCase().split(".").pop();
  return ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/jpeg";
}

/** getFile → download the bytes, enforcing the 20 MB transport cap at both the metadata and byte stage.
 *  The shared core of fetching an image (→ vision) and a file (→ disk). Throws on failure / oversize. */
async function getFileBytes(
  api: string,
  botToken: string,
  fileId: string,
): Promise<{ bytes: Buffer; remotePath: string }> {
  const meta = await callApi(api, botToken, "getFile", { file_id: fileId });
  const remotePath = meta.file_path;
  if (!remotePath) throw new Error(`telegram getFile: no file_path in response for ${fileId}`);
  if ((meta.file_size ?? 0) > MAX_DOWNLOAD_BYTES) throw new Error("file is too large (max 20 MB)");
  // The byte download is the one non-JSON call (a GET of the file endpoint), so it cannot ride the
  // pipeline — same timeout + naming discipline, applied here once.
  let res: Response;
  let buf: ArrayBuffer | undefined;
  let errBody: string | undefined;
  try {
    res = await fetch(`${api}/file/bot${botToken}/${remotePath}`, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    buf = res.ok ? await res.arrayBuffer() : undefined;
    errBody = res.ok ? undefined : await res.text(); // the error body self-describes (expired path etc.)
  } catch (e) {
    throw new TelegramApiError("file download", 0, String(e), { cause: e });
  }
  if (!res.ok || buf === undefined) {
    let description: string | undefined;
    try {
      description = (JSON.parse(errBody ?? "") as { description?: string }).description;
    } catch {
      /* non-JSON error body — fall through to the generic description */
    }
    throw new TelegramApiError(
      "file download",
      res.status,
      description ?? "Bot API response was not the expected JSON",
    );
  }
  const bytes = Buffer.from(buf);
  if (bytes.byteLength > MAX_DOWNLOAD_BYTES) throw new Error("file is too large (max 20 MB)");
  return { bytes, remotePath };
}

/** Resolve a Telegram file_id to an ImageRef (getFile → download → base64). Throws on failure / oversize. */
async function fetchTelegramImage(api: string, botToken: string, fileId: string): Promise<ImageRef> {
  const { bytes, remotePath } = await getFileBytes(api, botToken, fileId);
  return { mimeType: mimeFromPath(remotePath), data: bytes.toString("base64") };
}

/** Download a Telegram file_id to <cwd>/.fastagent/telegram-files/<chat>/<name>. Throws on failure / oversize. */
async function downloadTelegramFile(
  api: string,
  botToken: string,
  fileId: string,
  chatId: number | string,
): Promise<DownloadedFile> {
  const { bytes, remotePath } = await getFileBytes(api, botToken, fileId);
  const name = basename(remotePath);
  const dir = join(process.cwd(), FILES_SUBDIR, String(chatId));
  await mkdir(dir, { recursive: true });
  const dest = join(dir, name);
  await writeFile(dest, bytes);
  return { path: dest, name, size: bytes.byteLength };
}

/** Fetch the message's images. Throws if any cannot be loaded — the caller surfaces it (no silent drop). */
export async function resolveImages(
  api: string,
  botToken: string,
  fileIds: string[] | undefined,
): Promise<ImageRef[] | undefined> {
  if (!fileIds || fileIds.length === 0) return undefined;
  const images: ImageRef[] = [];
  for (const id of fileIds) images.push(await fetchTelegramImage(api, botToken, id));
  return images;
}

/** Download the message's files. Throws if any cannot be loaded — the caller surfaces it (no silent drop). */
export async function resolveFiles(
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
