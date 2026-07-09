import { defineTool, z } from "@kid7st/fastagent";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

// Send a message or a local file back to a Telegram chat. In a CHAT turn the channel delivers the
// reply itself — this tool is for files, and for turns NO channel is carrying: a scheduled turn
// (schedules/<name>.ts) or a self-scheduled wake-up, whose plain reply is not delivered anywhere.
// The chatId comes from the [telegram: chat …] context line in a chat turn; a scheduled turn has no
// such line, so the schedule's prompt must name the target chat id. tools/ is auto-discovered.
export default defineTool({
  description:
    "Send to a Telegram chat: a text message (`text`), or a local file (`path` — a document, or a photo " +
    "if it is an image). Exactly one of text/path. In a chat turn take chatId from the [telegram: chat …] " +
    "context line; in a scheduled/woken turn (no context line) the chat id must come from your " +
    "instruction. Telegram caps a message at 4096 chars — split longer text into multiple calls.",
  input: z.object({
    chatId: z.union([z.string(), z.number()]).describe("target chat id"),
    text: z.string().optional().describe("message text to send"),
    path: z.string().optional().describe("absolute path of the local file to send"),
    caption: z.string().optional().describe("file caption (file mode only)"),
    asPhoto: z.boolean().optional().describe("send the file as a photo (inline) instead of a document"),
    messageThreadId: z.number().optional().describe("thread to reply into (from the context line), if any"),
  }),
  async execute({ chatId, text, path, caption, asPhoto, messageThreadId }) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
    if ((text === undefined) === (path === undefined)) {
      throw new Error("pass exactly one of `text` (a message) or `path` (a file)");
    }
    const method = text !== undefined ? "sendMessage" : asPhoto ? "sendPhoto" : "sendDocument";
    const form = new FormData();
    form.set("chat_id", String(chatId));
    if (messageThreadId !== undefined) form.set("message_thread_id", String(messageThreadId));
    if (text !== undefined) {
      form.set("text", text);
    } else {
      if (caption) form.set("caption", caption);
      form.set(asPhoto ? "photo" : "document", new Blob([await readFile(path as string)]), basename(path as string));
    }
    // Standalone copy of the channel transport's discipline (this template cannot import core
    // internals): an upload timeout so a wedged connection can't hang the tool call (and the turn),
    // named errors, and success gated on the body's own ok. Deliberately NO 429 retry — a tool error
    // goes back to the agent, which can decide to retry; fail-fast beats a silently sleeping tool.
    let res: Response;
    let raw: string;
    try {
      res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(120_000),
      });
      raw = await res.text();
    } catch (e) {
      throw new Error(`telegram ${method}: ${String(e)}`, { cause: e });
    }
    let data: { ok?: boolean; description?: string };
    try {
      data = JSON.parse(raw) as { ok?: boolean; description?: string };
    } catch {
      data = {};
    }
    if (!res.ok || !data.ok) {
      throw new Error(
        `telegram ${method} failed: ${res.status} ${data.description ?? "Bot API response was not the expected JSON"}`,
      );
    }
    return text !== undefined ? `sent message to chat ${chatId}` : `sent ${basename(path as string)} to chat ${chatId}`;
  },
});
