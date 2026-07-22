import { defineTool, z } from "@fastagent-sh/fastagent";
import { open, stat } from "node:fs/promises";
import { basename } from "node:path";

// Send a message or upload a local file to Slack. In a CHAT turn the channel delivers the reply
// itself — do NOT call this to answer a normal chat turn (that posts the message twice). This tool is
// for file uploads, and for turns NO channel is carrying: a scheduled turn (schedules/<name>.ts) or a
// self-scheduled wake-up, whose plain reply is not delivered anywhere. The channelId/threadTs come
// from the [slack: …] context line in a chat turn; a scheduled/woken turn has no such line, so its
// prompt must name the target channel id. tools/ is auto-discovered.

const API = "https://slack.com/api";
const MAX_TEXT = 10_000;
const RETRIES = 3;
const MAX_RETRY_AFTER_S = 30;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function splitText(text: string): string[] {
  const points = Array.from(text);
  const chunks: string[] = [];
  let offset = 0;
  while (offset < points.length) {
    let end = Math.min(points.length, offset + MAX_TEXT);
    if (end < points.length) {
      const block = points.slice(offset, end).join("");
      const newline = block.lastIndexOf("\n");
      if (newline > 0) end = offset + Array.from(block.slice(0, newline)).length;
    }
    chunks.push(points.slice(offset, end).join(""));
    offset = end;
    if (points[offset] === "\n") offset++;
  }
  return chunks.length ? chunks : [""];
}

async function callSlack<T extends { ok?: boolean; error?: string }>(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    let raw: string;
    try {
      response = await fetch(`${API}/${method}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
      raw = await response.text();
    } catch (error) {
      throw new Error(`slack ${method}: ${String(error)}`, { cause: error });
    }
    let data: T;
    try {
      data = JSON.parse(raw) as T;
    } catch {
      data = {} as T;
    }
    if (response.ok && data.ok === true) return data;
    if ((response.status === 429 || data.error === "ratelimited") && attempt < RETRIES) {
      const retryAfter = Number(response.headers.get("retry-after") ?? attempt + 1);
      if (Number.isFinite(retryAfter) && retryAfter <= MAX_RETRY_AFTER_S) {
        await wait(Math.max(1, retryAfter) * 1000);
        continue;
      }
    }
    throw new Error(`slack ${method} failed: ${response.status} ${data.error ?? "unexpected response"}`);
  }
}

function trustedUploadUrl(value: string): URL {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  const slackHost =
    host === "slack-files.com" ||
    host.endsWith(".slack-files.com") ||
    host === "slack.com" ||
    host.endsWith(".slack.com") ||
    host === "slack-edge.com" ||
    host.endsWith(".slack-edge.com");
  if (url.protocol !== "https:" || !slackHost) {
    throw new Error(`Slack returned an untrusted upload URL host: ${host}`);
  }
  return url;
}

export default defineTool({
  description:
    "Upload one local file to Slack (`path`), or send a message (`text`) for a turn NO channel is " +
    "carrying — a scheduled or self-scheduled (wake) turn. In a normal chat turn the channel already " +
    "delivers your reply, so do NOT call this to answer (it would post the message twice). Pass exactly " +
    "one of `text`/`path`. channelId/threadTs come from the [slack: …] context line in a chat turn; a " +
    "scheduled/woken turn has no context line, so name the destination in your instruction.",
  input: z.object({
    channelId: z.string().describe("target Slack channel ID"),
    text: z.string().optional().describe("standard Markdown message text"),
    path: z.string().optional().describe("absolute path of a local file to upload"),
    title: z.string().optional().describe("file title (file mode only)"),
    initialComment: z.string().optional().describe("message posted with the file (file mode only)"),
    threadTs: z.string().optional().describe("thread parent timestamp, if replying in a thread"),
  }),
  async execute({ channelId, text, path, title, initialComment, threadTs }) {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) throw new Error("SLACK_BOT_TOKEN is not set");
    if ((text === undefined) === (path === undefined)) throw new Error("pass exactly one of `text` or `path`");

    if (text !== undefined) {
      if (title !== undefined || initialComment !== undefined) {
        throw new Error("`title`/`initialComment` are file-mode only");
      }
      const chunks = splitText(text);
      for (const chunk of chunks) {
        await callSlack(token, "chat.postMessage", {
          channel: channelId,
          markdown_text: chunk,
          ...(threadTs ? { thread_ts: threadTs } : {}),
          unfurl_links: false,
          unfurl_media: false,
        });
      }
      return chunks.length === 1
        ? `sent message to Slack channel ${channelId}`
        : `sent ${chunks.length} messages to Slack channel ${channelId}`;
    }

    const filePath = path as string;
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error(`${filePath} is not a regular file`);
    const filename = basename(filePath);
    const upload = await callSlack<{ ok?: boolean; error?: string; upload_url?: string; file_id?: string }>(
      token,
      "files.getUploadURLExternal",
      { filename, length: info.size },
    );
    if (!upload.upload_url || !upload.file_id) throw new Error("Slack upload URL response carried no upload_url/file_id");

    let byteResponse: Response;
    const handle = await open(filePath, "r");
    try {
      byteResponse = await fetch(trustedUploadUrl(upload.upload_url), {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: handle.readableWebStream(),
        signal: AbortSignal.timeout(120_000),
        // Required by Node fetch for a streaming request body; not part of the browser RequestInit type.
        duplex: "half",
      } as RequestInit & { duplex: "half" });
    } catch (error) {
      throw new Error(`Slack file byte upload failed: ${String(error)}`, { cause: error });
    } finally {
      await handle.close().catch(() => {});
    }
    if (!byteResponse.ok) {
      throw new Error(`Slack file byte upload failed: ${byteResponse.status} ${await byteResponse.text()}`);
    }

    // At-least-once: if Slack commits this call but the response is lost, a tool retry may post a
    // duplicate. Retrying automatically here would hide that ambiguity, so only explicit agent/user
    // retry crosses this final side-effect boundary.
    await callSlack(token, "files.completeUploadExternal", {
      files: [{ id: upload.file_id, title: title ?? filename }],
      channel_id: channelId,
      ...(initialComment ? { initial_comment: initialComment } : {}),
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
    return `uploaded ${filename} to Slack channel ${channelId}`;
  },
});
