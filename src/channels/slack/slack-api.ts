/** Slack Web API transport: one JSON pipeline, authenticated capped private-file downloads, and the
 * external-upload protocol. */
import { mkdir, open, stat, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import type { ImageRef } from "../../agent.ts";
import { attachmentPath } from "../kit/attachment-path.ts";
import { codePointPrefix } from "../kit/text.ts";
import type { SlackFile } from "./model.ts";

const API_TIMEOUT_MS = 30_000;
const FILE_TRANSFER_TIMEOUT_MS = 120_000;
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const RETRIES = 3;
const MAX_RETRY_AFTER_S = 30;
/** Slack's standard-Markdown fields cap each call at 12,000 characters. Keep headroom for
 * code-fence balancing and future server-side transformations. */
const SLACK_MAX_MARKDOWN = 10_000;

export interface SlackTarget {
  channelId: string;
  threadTs?: string;
  /** Required by Slack when a native stream replies in a channel rather than a DM. */
  recipientUserId?: string;
  recipientTeamId?: string;
}

export interface DownloadedSlackFile {
  path: string;
  name: string;
  size: number;
}

export interface UploadedSlackFile {
  id: string;
  name: string;
}

export interface SentSlackMessage {
  /** The first message's ts (a long Markdown body continues in further messages). */
  ts: string;
  /** Where it landed: a user-id target (`U…`) resolves to that user's DM channel (`D…`). */
  channelId: string;
}

interface SlackBody {
  ok?: boolean;
  error?: string;
  needed?: string;
  provided?: string;
  response_metadata?: { messages?: string[] };
  [key: string]: unknown;
}

export class SlackApiError extends Error {
  readonly method: string;
  readonly status: number;
  readonly slackError?: string;

  constructor(method: string, status: number, description: string, slackError?: string, options?: { cause?: unknown }) {
    super(
      status === 0 ? `slack ${method}: ${description}` : `slack ${method} failed: ${status} ${description}`,
      options,
    );
    this.name = "SlackApiError";
    this.method = method;
    this.status = status;
    this.slackError = slackError;
  }
}

const NATIVE_UNAVAILABLE_ERRORS = new Set([
  "channel_type_not_supported",
  "messages_tab_disabled",
  "method_deprecated",
  "missing_scope",
  "no_permission",
  "not_allowed_token_type",
]);

/** A definitive capability rejection is safe to route through the compatibility renderer. Network,
 * internal, and timeout failures are ambiguous: Slack may already have created the stream. */
export function isSlackNativeUnavailable(error: unknown): boolean {
  return error instanceof SlackApiError && !!error.slackError && NATIVE_UNAVAILABLE_ERRORS.has(error.slackError);
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface SlackApiOptions {
  botToken: string;
  baseUrl?: string;
}

export interface SlackApi {
  authTest(): Promise<{ teamId?: string; userId?: string; botId?: string }>;
  postMessage(target: SlackTarget, text: string): Promise<string>;
  postMarkdown(target: SlackTarget, markdown: string): Promise<string>;
  updateMessage(channelId: string, ts: string, text: string): Promise<void>;
  updateMarkdown(channelId: string, ts: string, markdown: string): Promise<void>;
  deleteMessage(channelId: string, ts: string): Promise<void>;
  /** Post standard Markdown, split under Slack's limit. `target.channelId` may be a user id: Slack
   *  then opens (or reuses) the app's DM with that user, and the result names it. */
  sendMarkdown(target: SlackTarget, markdown: string): Promise<SentSlackMessage>;
  startStream(target: SlackTarget, markdown?: string): Promise<string>;
  appendStream(channelId: string, ts: string, markdown: string): Promise<void>;
  stopStream(channelId: string, ts: string, markdown?: string): Promise<void>;
  setThreadStatus(target: SlackTarget, status: string): Promise<void>;
  setThreadTitle(target: SlackTarget, title: string): Promise<void>;
  addReaction(channelId: string, timestamp: string, emoji: string): Promise<void>;
  removeReaction(channelId: string, timestamp: string, emoji: string): Promise<void>;
  fileInfo(fileId: string): Promise<SlackFile>;
  fetchImage(file: SlackFile): Promise<ImageRef>;
  fetchFile(file: SlackFile, channelId: string, filesDir: string): Promise<DownloadedSlackFile>;
  /** Upload one local file into a channel/thread through Slack's external-upload protocol
   *  (getUploadURLExternal → bytes → completeUploadExternal). */
  uploadFile(
    target: SlackTarget,
    path: string,
    options?: { title?: string; initialComment?: string },
  ): Promise<UploadedSlackFile>;
}

/** Split a Slack text/Markdown field at a code-point-safe boundary, preferring a newline. */
export function chunkSlackText(text: string, maxPoints = SLACK_MAX_MARKDOWN): string[] {
  if (!Number.isSafeInteger(maxPoints) || maxPoints <= 0) throw new RangeError("maxPoints must be a positive integer");
  const points = Array.from(text);
  if (points.length <= maxPoints) return [text];
  const chunks: string[] = [];
  let offset = 0;
  while (offset < points.length) {
    let end = Math.min(points.length, offset + maxPoints);
    if (end < points.length) {
      const window = points.slice(offset, end).join("");
      const paragraph = window.lastIndexOf("\n\n");
      const newline = window.lastIndexOf("\n");
      const boundary = paragraph >= 0 ? paragraph + 2 : newline >= 0 ? newline + 1 : -1;
      if (boundary > 0) end = offset + Array.from(window.slice(0, boundary)).length;
    }
    chunks.push(points.slice(offset, end).join(""));
    offset = end;
  }
  return chunks.length ? chunks : [""];
}

/** Split standard Markdown while balancing fenced code blocks across separately posted messages. */
export function chunkSlackMarkdown(markdown: string, maxPoints = SLACK_MAX_MARKDOWN): string[] {
  if (!Number.isSafeInteger(maxPoints) || maxPoints < 256) {
    throw new RangeError("Markdown chunk size must be an integer of at least 256 code points");
  }
  if (Array.from(markdown).length <= maxPoints) return [markdown];
  const rawChunks = chunkSlackText(markdown, maxPoints - 128);
  let fence: { marker: string; opening: string } | undefined;
  const output: string[] = [];
  for (const raw of rawChunks) {
    const entering = fence;
    for (const line of raw.split("\n")) {
      const match = line.trim().match(/^(`{3,}|~{3,})(.*)$/);
      if (!match) continue;
      const marker = match[1] ?? "```";
      // Pathological fences longer than our reserved balancing headroom are left untouched rather than
      // making a generated chunk exceed Slack's API limit.
      if (marker.length > 64) continue;
      if (!fence) {
        fence = { marker, opening: `${marker}${(match[2] ?? "").slice(0, 64)}` };
      } else if (marker[0] === fence.marker[0] && marker.length >= fence.marker.length) {
        fence = undefined;
      }
    }
    const prefix = entering ? `${entering.opening}\n` : "";
    const suffix = fence ? `\n${fence.marker}` : "";
    output.push(`${prefix}${raw}${suffix}`);
  }
  return output;
}

function fileDownloadUrl(file: SlackFile): string {
  if (file.file_access === "check_file_info") throw new Error(`Slack file ${file.id ?? "(unknown)"} is not ready`);
  if (file.file_access === "access_denied") throw new Error(`Slack file ${file.id ?? "(unknown)"} is not accessible`);
  const url = file.url_private_download ?? file.url_private;
  if (!url) {
    const kind = file.is_external ? `external (${file.external_type ?? "unknown"})` : (file.mode ?? "unknown");
    throw new Error(`Slack file ${file.id ?? "(unknown)"} has no downloadable bytes (${kind})`);
  }
  if ((file.size ?? 0) > MAX_DOWNLOAD_BYTES) throw new Error("Slack file is too large (max 20 MB)");
  return url;
}

async function readBytesCapped(response: Response): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES)
    throw new Error("Slack file is too large (max 20 MB)");
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_DOWNLOAD_BYTES) {
      await reader.cancel("download exceeds cap").catch(() => {});
      throw new Error("Slack file is too large (max 20 MB)");
    }
    chunks.push(value);
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  );
}

export function createSlackApi({ botToken, baseUrl = "https://slack.com/api" }: SlackApiOptions): SlackApi {
  const apiBase = baseUrl.replace(/\/$/, "");

  const call = async <T extends SlackBody>(
    method: string,
    body: Record<string, unknown>,
    httpMethod: "GET" | "POST" = "POST",
  ): Promise<T> => {
    const url = new URL(`${apiBase}/${method}`);
    if (httpMethod === "GET") {
      for (const [name, value] of Object.entries(body)) {
        if (value !== undefined) url.searchParams.set(name, String(value));
      }
    }
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      let raw: string;
      try {
        response = await fetch(url, {
          method: httpMethod,
          headers: {
            authorization: `Bearer ${botToken}`,
            ...(httpMethod === "POST" ? { "content-type": "application/json; charset=utf-8" } : {}),
          },
          ...(httpMethod === "POST" ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(API_TIMEOUT_MS),
        });
        raw = await response.text();
      } catch (error) {
        throw new SlackApiError(method, 0, String(error), undefined, { cause: error });
      }
      let data: T;
      try {
        data = JSON.parse(raw) as T;
      } catch {
        data = {} as T;
      }
      if (response.ok && data.ok === true) return data;
      const rateLimited = response.status === 429 || data.error === "ratelimited";
      if (rateLimited && attempt < RETRIES) {
        const retryAfter = Number(response.headers.get("retry-after") ?? attempt + 1);
        if (Number.isFinite(retryAfter) && retryAfter <= MAX_RETRY_AFTER_S) {
          await wait(Math.max(1, retryAfter) * 1000);
          continue;
        }
      }
      const detail = [
        data.error ?? "response was not the expected Slack JSON",
        data.needed ? `needed ${data.needed}` : undefined,
        ...(data.response_metadata?.messages ?? []),
      ]
        .filter(Boolean)
        .join("; ");
      throw new SlackApiError(method, response.status, detail, data.error);
    }
  };

  // Slack owns both halves of this download: the URL comes from its own files.info response, and it
  // documents url_private as taking our bearer token. Where that URL leads is Slack's call; whether a
  // redirect hop still carries the token is fetch's, which drops the header cross-origin.
  const download = async (file: SlackFile): Promise<{ bytes: Buffer; contentType?: string }> => {
    let response: Response;
    try {
      response = await fetch(fileDownloadUrl(file), {
        headers: { authorization: `Bearer ${botToken}` },
        signal: AbortSignal.timeout(FILE_TRANSFER_TIMEOUT_MS),
      });
    } catch (error) {
      throw new SlackApiError("file download", 0, String(error), undefined, { cause: error });
    }
    if (!response.ok) {
      const detail = codePointPrefix(await response.text().catch(() => ""), 300) || "file bytes were rejected";
      throw new SlackApiError("file download", response.status, detail);
    }
    return { bytes: await readBytesCapped(response), contentType: response.headers.get("content-type") ?? undefined };
  };

  const postMarkdown = async (target: SlackTarget, markdown: string): Promise<SentSlackMessage> => {
    const data = await call<SlackBody & { ts?: string; channel?: string }>("chat.postMessage", {
      channel: target.channelId,
      markdown_text: markdown,
      ...(target.threadTs ? { thread_ts: target.threadTs } : {}),
      unfurl_links: false,
      unfurl_media: false,
    });
    if (!data.ts) throw new SlackApiError("chat.postMessage", 200, "response carried no ts");
    // The response's `channel` is what resolves a user-id target to its DM; a channel target echoes itself.
    return { ts: data.ts, channelId: data.channel ?? target.channelId };
  };

  const api: SlackApi = {
    async authTest() {
      const data = await call<SlackBody & { team_id?: string; user_id?: string; bot_id?: string }>("auth.test", {});
      return { teamId: data.team_id, userId: data.user_id, botId: data.bot_id };
    },
    async postMessage(target, text) {
      const data = await call<SlackBody & { ts?: string }>("chat.postMessage", {
        channel: target.channelId,
        text,
        ...(target.threadTs ? { thread_ts: target.threadTs } : {}),
        unfurl_links: false,
        unfurl_media: false,
      });
      if (!data.ts) throw new SlackApiError("chat.postMessage", 200, "response carried no ts");
      return data.ts;
    },
    async postMarkdown(target, markdown) {
      return (await postMarkdown(target, markdown)).ts;
    },
    async updateMessage(channelId, ts, text) {
      try {
        await call("chat.update", { channel: channelId, ts, text });
      } catch (error) {
        if (error instanceof SlackApiError && error.slackError === "message_not_modified") return;
        throw error;
      }
    },
    async updateMarkdown(channelId, ts, markdown) {
      try {
        await call("chat.update", { channel: channelId, ts, markdown_text: markdown });
      } catch (error) {
        if (error instanceof SlackApiError && error.slackError === "message_not_modified") return;
        throw error;
      }
    },
    async deleteMessage(channelId, ts) {
      await call("chat.delete", { channel: channelId, ts });
    },
    async sendMarkdown(target, markdown) {
      let first: SentSlackMessage | undefined;
      for (const chunk of chunkSlackMarkdown(markdown)) {
        // Continuations go to the resolved channel: a user-id target must not reopen the DM per chunk.
        const sent = await postMarkdown(first ? { ...target, channelId: first.channelId } : target, chunk);
        first ??= sent;
      }
      return first as SentSlackMessage; // chunkSlackMarkdown never yields zero chunks
    },
    async startStream(target, markdown) {
      if (!target.threadTs) throw new Error("Slack native streams require a parent thread timestamp");
      const channelRecipient = target.channelId.startsWith("D")
        ? {}
        : {
            recipient_user_id: target.recipientUserId,
            recipient_team_id: target.recipientTeamId,
          };
      if (!target.channelId.startsWith("D") && (!target.recipientUserId || !target.recipientTeamId)) {
        throw new Error("Slack native channel streams require recipient user and team IDs");
      }
      const data = await call<SlackBody & { ts?: string }>("chat.startStream", {
        channel: target.channelId,
        thread_ts: target.threadTs,
        ...channelRecipient,
        ...(markdown ? { markdown_text: markdown } : {}),
      });
      if (!data.ts) throw new SlackApiError("chat.startStream", 200, "response carried no ts");
      return data.ts;
    },
    async appendStream(channelId, ts, markdown) {
      await call("chat.appendStream", { channel: channelId, ts, markdown_text: markdown });
    },
    async stopStream(channelId, ts, markdown) {
      await call("chat.stopStream", {
        channel: channelId,
        ts,
        ...(markdown ? { markdown_text: markdown } : {}),
      });
    },
    async setThreadStatus(target, status) {
      if (!target.threadTs) return;
      await call("assistant.threads.setStatus", {
        channel_id: target.channelId,
        thread_ts: target.threadTs,
        status,
      });
    },
    async setThreadTitle(target, title) {
      if (!target.threadTs) return;
      await call("assistant.threads.setTitle", {
        channel_id: target.channelId,
        thread_ts: target.threadTs,
        title,
      });
    },
    async addReaction(channelId, timestamp, emoji) {
      try {
        await call("reactions.add", { channel: channelId, timestamp, name: emoji });
      } catch (error) {
        if (error instanceof SlackApiError && error.slackError === "already_reacted") return;
        throw error;
      }
    },
    async removeReaction(channelId, timestamp, emoji) {
      try {
        await call("reactions.remove", { channel: channelId, timestamp, name: emoji });
      } catch (error) {
        if (error instanceof SlackApiError && error.slackError === "no_reaction") return;
        throw error;
      }
    },
    async fileInfo(fileId) {
      const data = await call<SlackBody & { file?: SlackFile }>("files.info", { file: fileId }, "GET");
      if (!data.file?.id) throw new SlackApiError("files.info", 200, `response carried no file for ${fileId}`);
      return data.file;
    },
    async fetchImage(file) {
      const { bytes, contentType } = await download(file);
      const mime = (file.mimetype ?? contentType?.split(";")[0]?.trim() ?? "").toLowerCase();
      if (!mime.startsWith("image/"))
        throw new Error(`Slack file ${file.id ?? "(unknown)"} is not an image (${mime || "unknown type"})`);
      return { mimeType: mime, data: bytes.toString("base64") };
    },
    async fetchFile(file, channelId, filesDir) {
      const { bytes } = await download(file);
      // The id prefix keeps two same-named uploads in one channel apart.
      const suggested = `${file.id ?? "slack"}-${file.name ?? file.title ?? file.id ?? "file"}`;
      const { dir, name, path } = attachmentPath(filesDir, channelId, suggested);
      await mkdir(dir, { recursive: true });
      await writeFile(path, bytes);
      return { path, name, size: bytes.byteLength };
    },
    async uploadFile(target, path, options = {}) {
      const info = await stat(path);
      if (!info.isFile()) throw new Error(`${path} is not a regular file`);
      const name = basename(path);
      const upload = await call<SlackBody & { upload_url?: string; file_id?: string }>("files.getUploadURLExternal", {
        filename: name,
        length: info.size,
      });
      if (!upload.upload_url || !upload.file_id) {
        throw new SlackApiError("files.getUploadURLExternal", 200, "response carried no upload_url/file_id");
      }
      // Where upload_url points is Slack's call, as with url_private above; the bytes carry no token.
      const handle = await open(path, "r");
      let response: Response;
      try {
        response = await fetch(upload.upload_url, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: handle.readableWebStream(),
          signal: AbortSignal.timeout(FILE_TRANSFER_TIMEOUT_MS),
          // Required by Node fetch for a streaming request body; not part of the browser RequestInit type.
          duplex: "half",
        } as RequestInit & { duplex: "half" });
      } catch (error) {
        throw new SlackApiError("file upload", 0, String(error), undefined, { cause: error });
      } finally {
        await handle.close().catch(() => {});
      }
      if (!response.ok) {
        const detail = codePointPrefix(await response.text().catch(() => ""), 300) || "file bytes were rejected";
        throw new SlackApiError("file upload", response.status, detail);
      }
      // At-least-once: if Slack commits this call but the response is lost, a retry may post a
      // duplicate. Retrying here would hide that ambiguity, so only an explicit agent/user retry
      // crosses this final side-effect boundary.
      await call("files.completeUploadExternal", {
        files: [{ id: upload.file_id, title: options.title ?? name }],
        channel_id: target.channelId,
        ...(options.initialComment ? { initial_comment: options.initialComment } : {}),
        ...(target.threadTs ? { thread_ts: target.threadTs } : {}),
      });
      return { id: upload.file_id, name };
    },
  };
  return api;
}
