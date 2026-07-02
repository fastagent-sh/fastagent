/**
 * Telegram Bot API transport: the wire calls the channel orchestrates (telegram.ts). No agent, no
 * rendering — just `fetch` to the Bot API, with the protocol's hard edges handled here (timeouts, 429
 * backoff, the 4096-char split, the HTML→plain parse fallback, the getFile→download dance). Split from the
 * channel so policy/streaming stays separate from the wire protocol.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ImageRef } from "../../agent.ts";

/** Sleep on the GLOBAL timer (not `node:timers/promises`) so tests can drive it with fake timers. */
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Parse a Bot API response body; a non-JSON body (a proxy's error page) is treated as empty — the
 *  caller then fails on the missing `ok` field rather than trusting an intermediary's HTTP 200. Only the
 *  PARSE is forgiven here: a network/timeout error while READING the body happens at the `res.text()`
 *  call sites, inside their context-adding try/catch. */
function parseBotJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** The self-description when a body carries no usable Bot API answer — either not JSON at all (an
 *  intermediary's error page) or JSON without the expected fields. Phrased to be true for both; callers
 *  that can tell a more specific truth (e.g. "no file_path") say that instead. */
const MALFORMED_BODY = "Bot API response was not the expected JSON";

/** Telegram's hard text limit per message. */
export const TELEGRAM_MAX_TEXT = 4096;
const PARSE_ERROR = /can't parse|entit|unsupported|unclosed|tag/i;

/** Per-attempt timeout for a JSON Bot API call — without one a wedged connection hangs the turn (and the
 *  session's serial queue behind it) forever. Generous: these are small JSON round-trips. */
const API_TIMEOUT_MS = 30_000;

/** Timeout for downloading file bytes (up to the 20 MB cap) — sized for a slow link, not a JSON call. */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** Longest flood wait (seconds) we honour PER ATTEMPT before failing visibly instead. Telegram's
 *  `retry_after` can reach minutes–hours on a flood ban; sleeping that long would silently hold the turn
 *  and every queued turn behind it — a fast, diagnosable failure is better. The aggregate is bounded by
 *  the retry count: at most 3 waits, so ~3× this cap worst-case. */
const FLOOD_WAIT_MAX_S = 30;

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

/** One Bot API call, retrying on a 429 (a few attempts): waits the server's `retry_after` when given
 *  (exported for the tunnel's setWebhook registration — one hardened call, not parallel copies)
 *  (a missing one gets a short linear backoff), but only up to {@link FLOOD_WAIT_MAX_S} — beyond that
 *  the flood ban fails visibly rather than silently parking the turn. No retry on other statuses or on
 *  network errors/timeouts: the request may have been processed, and a retried sendMessage would
 *  double-deliver; those fail visibly (a thrown fetch error, or `ok:false`) for the caller to surface. */
export async function callBotApi(
  api: string,
  botToken: string,
  method: string,
  params: Record<string, unknown>,
): Promise<{ ok: true; result?: { message_id?: number } } | { ok: false; status: number; description: string }> {
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
      raw = await res.text(); // the body read is under the same timeout — keep it in the guarded region
    } catch (e) {
      // Name the call: a bare `TimeoutError` in the operator log names no method — the whole point of
      // the timeout is a diagnosable failure.
      throw new Error(`telegram ${method}: ${String(e)}`, { cause: e });
    }
    const data = parseBotJson(raw) as {
      ok?: boolean;
      result?: { message_id?: number };
      description?: string;
      parameters?: { retry_after?: number };
    };
    // Success requires the BODY's own `ok:true` (every Bot API response carries it), not just HTTP 200:
    // a proxy's 200 + HTML error page must be a named failure, not a fake success with no message_id.
    if (res.ok && data.ok === true) return { ok: true, result: data.result };
    if (res.ok) {
      return {
        ok: false,
        status: res.status,
        description: data.description ?? MALFORMED_BODY,
      };
    }
    if (res.status === 429 && attempt < 3) {
      const floodWait = data.parameters?.retry_after ?? attempt + 1;
      if (floodWait <= FLOOD_WAIT_MAX_S) {
        await wait((floodWait + 1) * 1000);
        continue;
      }
      // A longer flood ban fails visibly — and says WHY the transport refused to wait, rather than
      // relying on the server's description to mention the retry_after.
      return {
        ok: false,
        status: res.status,
        description:
          `${data.description ?? ""} (retry_after ${floodWait}s exceeds the ${FLOOD_WAIT_MAX_S}s flood-wait cap)`.trim(),
      };
    }
    // Same self-describing rule for the other transport decision: a 429 that survived every retry says
    // so, distinguishable in the log from one that was never retried.
    const exhausted = res.status === 429 ? ` (gave up after ${attempt} retries)` : "";
    return { ok: false, status: res.status, description: `${data.description ?? MALFORMED_BODY}${exhausted}`.trim() };
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
    let result = mode
      ? await callBotApi(api, botToken, "sendMessage", { ...base, parse_mode: "HTML" })
      : await callBotApi(api, botToken, "sendMessage", base);
    if (mode && !result.ok && PARSE_ERROR.test(result.description)) {
      if (first) {
        // Nothing sent yet — re-chunk the whole body as plain (no injected boundary tags leak) and restart.
        mode = false;
        chunks = chunkText(body, { html: false });
        i = -1;
        continue;
      }
      // A later chunk failed after the first parsed cleanly (rare) — best-effort plain resend of this chunk.
      result = await callBotApi(api, botToken, "sendMessage", base);
    }
    if (!result.ok) throw new Error(`telegram sendMessage failed: ${result.status} ${result.description}`.trim());
    if (first) firstId = result.result?.message_id;
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
  let result = opts.html
    ? await callBotApi(api, botToken, "editMessageText", { ...base, parse_mode: "HTML" })
    : await callBotApi(api, botToken, "editMessageText", base);
  if (opts.html && !result.ok && PARSE_ERROR.test(result.description))
    result = await callBotApi(api, botToken, "editMessageText", base);
  if (!result.ok && /message is not modified/i.test(result.description)) return;
  if (!result.ok) throw new Error(`telegram editMessageText failed: ${result.status} ${result.description}`.trim());
}

/** Delete a message — the wire primitive for removing a preview placeholder (the finalize POLICY lives
 *  in telegram.ts). Throws on failure, like the other primitives; a caller that wants best-effort cleanup
 *  catches explicitly rather than the primitive swallowing it. */
export async function deleteMessage(api: string, botToken: string, t: Target, messageId: number): Promise<void> {
  const result = await callBotApi(api, botToken, "deleteMessage", { chat_id: t.chatId, message_id: messageId });
  if (!result.ok) throw new Error(`telegram deleteMessage failed: ${result.status} ${result.description}`.trim());
}
/** getMe: the bot's own @username (so default routing recognises group @mentions) and whether group
 *  privacy mode is OFF (`can_read_all_group_messages`) — needed to receive the un-summoned group
 *  messages that feed the context buffer. */
export async function resolveBotInfo(
  api: string,
  botToken: string,
): Promise<{ username?: string; canReadAllGroupMessages?: boolean }> {
  let res: Response;
  let raw: string;
  try {
    res = await fetch(`${api}/bot${botToken}/getMe`, { signal: AbortSignal.timeout(API_TIMEOUT_MS) });
    raw = await res.text();
  } catch (e) {
    throw new Error(`telegram getMe: ${String(e)}`, { cause: e });
  }
  const data = parseBotJson(raw) as {
    ok?: boolean;
    description?: string;
    result?: { username?: string; can_read_all_group_messages?: boolean };
  };
  if (!res.ok || !data.ok) {
    throw new Error(`telegram getMe failed: ${res.status} ${data.description ?? MALFORMED_BODY}`);
  }
  return { username: data.result?.username, canReadAllGroupMessages: data.result?.can_read_all_group_messages };
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
  let meta: { ok?: boolean; description?: string; result?: { file_path?: string; file_size?: number } };
  let metaStatus: number;
  try {
    const res = await fetch(`${api}/bot${botToken}/getFile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file_id: fileId }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    metaStatus = res.status;
    meta = parseBotJson(await res.text()) as typeof meta;
  } catch (e) {
    throw new Error(`telegram getFile: ${String(e)}`, { cause: e });
  }
  const remotePath = meta.result?.file_path;
  if (!meta.ok || !remotePath) {
    // A valid `ok:true` body missing file_path gets the specific truth, not the generic one.
    const why = meta.ok ? "no file_path in response" : (meta.description ?? MALFORMED_BODY);
    throw new Error(`telegram getFile failed for ${fileId}: ${metaStatus} ${why}`);
  }
  if ((meta.result?.file_size ?? 0) > MAX_DOWNLOAD_BYTES) throw new Error("file is too large (max 20 MB)");
  let res: Response;
  let buf: ArrayBuffer | undefined;
  let errBody: string | undefined;
  try {
    res = await fetch(`${api}/file/bot${botToken}/${remotePath}`, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    // The error body self-describes too (an expired file_path's "Not Found") — read it in the guarded region.
    buf = res.ok ? await res.arrayBuffer() : undefined;
    errBody = res.ok ? undefined : await res.text();
  } catch (e) {
    throw new Error(`telegram file download: ${String(e)}`, { cause: e });
  }
  if (!res.ok || buf === undefined) {
    const why = (parseBotJson(errBody ?? "") as { description?: string }).description ?? MALFORMED_BODY;
    throw new Error(`telegram file download failed: ${res.status} ${why}`);
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
