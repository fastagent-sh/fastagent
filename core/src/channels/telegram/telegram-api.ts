/**
 * Telegram Bot API transport: the wire calls the channel orchestrates (telegram.ts). No agent, no
 * rendering — just `fetch` to the Bot API, with the protocol's hard edges handled here (429 backoff,
 * the 4096-char split, the HTML→plain parse fallback, the getFile→download dance). Split from the
 * channel so policy/streaming stays separate from the wire protocol.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { ImageRef } from "../../agent.ts";

/** Telegram's hard text limit per message. */
const TELEGRAM_MAX_TEXT = 4096;
const PARSE_ERROR = /can't parse|entit|unsupported|unclosed|tag/i;

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
    const data = (await res.json().catch(() => ({}))) as {
      description?: string;
      parameters?: { retry_after?: number };
    };
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
 * Persist a final reply: split to Telegram's 4096-char limit, and send each chunk as HTML, falling back
 * to plain text only if Telegram rejects the markup — so a model formatting slip degrades instead of
 * losing the message. Format is the channel's job (Telegram's own parser); the developer never picks it.
 * `message_thread_id` is dropped from the JSON when undefined (linear chat).
 */
export async function sendMessage(api: string, botToken: string, t: Target, body: string): Promise<void> {
  let first = true;
  for (const chunk of chunkText(body)) {
    const base: Record<string, unknown> = { chat_id: t.chatId, message_thread_id: t.threadId, text: chunk };
    // Reply to the summoning message on the FIRST chunk only — threads the answer under the asker in a
    // group; allow_sending_without_reply so a since-deleted original still delivers. Continuation
    // chunks post plainly right after (N reply-quotes would be noise).
    if (first && t.replyTo !== undefined) {
      base.reply_parameters = { message_id: t.replyTo, allow_sending_without_reply: true };
    }
    first = false;
    let result = await callBotApi(api, botToken, "sendMessage", { ...base, parse_mode: "HTML" });
    if (!result.ok && PARSE_ERROR.test(result.description))
      result = await callBotApi(api, botToken, "sendMessage", base);
    if (!result.ok) throw new Error(`telegram sendMessage failed: ${result.status} ${result.description}`.trim());
  }
}

/** Push an ephemeral draft (animated preview, capped at the text limit). Same draft_id animates updates. */
export async function sendMessageDraft(
  api: string,
  botToken: string,
  t: Target,
  draftId: number,
  body: string,
): Promise<void> {
  const result = await callBotApi(api, botToken, "sendMessageDraft", {
    chat_id: t.chatId,
    message_thread_id: t.threadId,
    draft_id: draftId,
    text: body.slice(0, TELEGRAM_MAX_TEXT),
  });
  if (!result.ok) throw new Error(`telegram sendMessageDraft failed: ${result.status} ${result.description}`.trim());
}

/** getMe: the bot's own @username (so default routing recognises group @mentions) and whether group
 *  privacy mode is OFF (`can_read_all_group_messages`) — needed to receive the un-summoned group
 *  messages that feed the context buffer. */
export async function resolveBotInfo(
  api: string,
  botToken: string,
): Promise<{ username?: string; canReadAllGroupMessages?: boolean }> {
  const res = await fetch(`${api}/bot${botToken}/getMe`);
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: { username?: string; can_read_all_group_messages?: boolean };
  };
  if (!res.ok || !data.ok) throw new Error(`getMe failed: ${res.status}`);
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
  const meta = (await fetch(`${api}/bot${botToken}/getFile`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  }).then((r) => r.json())) as { ok?: boolean; result?: { file_path?: string; file_size?: number } };
  const remotePath = meta.result?.file_path;
  if (!meta.ok || !remotePath) throw new Error(`getFile failed for ${fileId}`);
  if ((meta.result?.file_size ?? 0) > MAX_DOWNLOAD_BYTES) throw new Error("file is too large (max 20 MB)");
  const res = await fetch(`${api}/file/bot${botToken}/${remotePath}`);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
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
