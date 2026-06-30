import { defineTool, z } from "@kid7st/fastagent";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

// Send a local file back to a Telegram chat. The agent passes a chatId it reads from the
// [telegram: chat …] context line the channel injects. tools/ is auto-discovered — no registration.
export default defineTool({
  description:
    "Send a local file to a Telegram chat (a document, or a photo if it is an image). Pass the chatId from the [telegram: chat …] context line.",
  input: z.object({
    chatId: z.union([z.string(), z.number()]).describe("target chat id (from the [telegram: chat …] context line)"),
    path: z.string().describe("absolute path of the local file to send"),
    caption: z.string().optional(),
    asPhoto: z.boolean().optional().describe("send as a photo (inline) instead of a document"),
    messageThreadId: z.number().optional().describe("thread to reply into (from the context line), if any"),
  }),
  async execute({ chatId, path, caption, asPhoto, messageThreadId }) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
    const method = asPhoto ? "sendPhoto" : "sendDocument";
    const form = new FormData();
    form.set("chat_id", String(chatId));
    if (messageThreadId !== undefined) form.set("message_thread_id", String(messageThreadId));
    if (caption) form.set("caption", caption);
    form.set(asPhoto ? "photo" : "document", new Blob([await readFile(path)]), basename(path));
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", body: form });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    if (!res.ok || !data.ok) throw new Error(`telegram ${method} failed: ${res.status} ${data.description ?? ""}`);
    return `sent ${basename(path)} to chat ${chatId}`;
  },
});
