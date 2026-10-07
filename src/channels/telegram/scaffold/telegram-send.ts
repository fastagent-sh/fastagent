import { basename } from "node:path";
import { defineTool, z } from "@fastagent-sh/fastagent";
import { telegramTransport } from "@fastagent-sh/fastagent/telegram";

// Send a message or a local file to a Telegram chat. In a CHAT turn the channel delivers the
// reply itself — this tool is for files, and for turns NO channel is carrying: a scheduled turn
// (schedules/<name>.md) or a self-scheduled wake-up, whose plain reply is not delivered anywhere.
// The chatId comes from the [telegram: chat …] context line in a chat turn; a scheduled turn has no
// such line, so the schedule's prompt must name the target chat id. tools/ is auto-discovered.
//
// Delivery rides the channel's own transport (telegramTransport): its token, Telegram's length cap,
// its rate-limit handling. What it sends becomes part of that chat's discussion, so the chat's next
// turn knows the agent said it — Telegram never echoes a bot its own messages. With no channel
// mounted (`fastagent tool`), it sends with TELEGRAM_BOT_TOKEN and says the message was not recorded.

export default defineTool({
  description:
    "Send to a Telegram chat: a text message (`text` — long text is split into multiple messages " +
    "automatically), or a local file (`path` — a document, or a photo if it is an image). Exactly one " +
    "of text/path. Use it for a turn NO channel is carrying — a scheduled or self-scheduled (wake) " +
    "turn — or to reach a chat OTHER than the one you are answering. In a normal chat turn the channel " +
    "already delivers your reply, so do NOT call this to answer (it would send it twice). chatId comes " +
    "from the [telegram: chat …] context line in a chat turn; a scheduled/woken turn has no context " +
    "line, so name the destination in your instruction. What you send is shown to you in that chat's " +
    "next turn.",
  input: z.object({
    chatId: z.union([z.string(), z.number()]).describe("target chat id"),
    text: z.string().optional().describe("message text to send"),
    path: z.string().optional().describe("absolute path of the local file to send"),
    caption: z.string().optional().describe("file caption (file mode only)"),
    asPhoto: z.boolean().optional().describe("send the file as a photo (inline) instead of a document"),
    messageThreadId: z.number().optional().describe("thread to reply into (from the context line), if any"),
  }),
  // The bot token, declared: fastagent carries it to a deployed box and refuses to start while it is
  // unset.
  secrets: ["TELEGRAM_BOT_TOKEN"],
  async execute({ chatId, text, path, caption, asPhoto, messageThreadId }, ctx) {
    if ((text === undefined) === (path === undefined)) {
      throw new Error("pass exactly one of `text` (a message) or `path` (a file)");
    }
    const telegram = telegramTransport(ctx.cwd);
    const target = { chatId, threadId: messageThreadId };
    if (text !== undefined) {
      // A file-only param alongside text would be silently dropped — same parameter-responsibility
      // class as the XOR above, so it gets the same corrective error, not a silent ignore.
      if (caption !== undefined || asPhoto !== undefined) {
        throw new Error("`caption`/`asPhoto` are file-mode only — with `text`, put everything in the text");
      }
      const sent = await telegram.sendText(target, text);
      const what =
        sent.messageIds.length === 1
          ? `sent message to chat ${chatId}`
          : `sent ${sent.messageIds.length} messages to chat ${chatId} (split at Telegram's length cap)`;
      return sent.notRecorded ? `${what}; not recorded: ${sent.notRecorded}` : what;
    }
    const sent = await telegram.sendFile(target, { path: path as string, caption, asPhoto });
    const what = `sent ${basename(path as string)} to chat ${chatId}`;
    return sent.notRecorded ? `${what}; not recorded: ${sent.notRecorded}` : what;
  },
});
