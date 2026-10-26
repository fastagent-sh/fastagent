import { basename } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { needs } from "@fastagent-sh/fastagent";
import { telegramTransport } from "@fastagent-sh/fastagent/telegram";

// Send a message or a local file to a Telegram chat. In a CHAT turn the channel delivers the
// reply itself: this tool is for files, and for messages NO channel is carrying: a schedule's
// (src/schedules/) or a self-scheduled wake-up's, whose plain reply is not delivered anywhere.
// The chatId comes from the [telegram: chat …] context line in a chat turn; a scheduled message has
// no such line, so the schedule's prompt must name the target chat id.
//
// Delivery rides the channel's own transport (telegramTransport): its token, Telegram's length cap,
// its rate-limit handling. What it sends becomes part of that chat's discussion, so the chat's next
// turn knows the agent said it (Telegram never echoes a bot its own messages). With no channel
// mounted, it sends with TELEGRAM_BOT_TOKEN and says the message was not recorded.
export default needs(["TELEGRAM_BOT_TOKEN"], ({ TELEGRAM_BOT_TOKEN }) =>
  defineTool({
    name: "telegram_send",
    description:
      "Send to a Telegram chat: a text message (`text`: long text is split into multiple messages " +
      "automatically), or a local file (`path`: a document, or a photo if it is an image). Exactly one " +
      "of text/path. Use it for a message NO channel is carrying (a scheduled or self-scheduled one) " +
      "or to reach a chat OTHER than the one you are answering. In a normal chat turn the channel " +
      "already delivers your reply, so do NOT call this to answer (it would send it twice). chatId comes " +
      "from the [telegram: chat …] context line in a chat turn; a scheduled or woken message has no context " +
      "line, so name the destination in your instruction. What you send is shown to you in that chat's " +
      "next turn.",
    parameters: Type.Object({
      chatId: Type.Union([Type.String(), Type.Number()], { description: "target chat id" }),
      text: Type.Optional(Type.String({ description: "message text to send" })),
      path: Type.Optional(Type.String({ description: "absolute path of the local file to send" })),
      caption: Type.Optional(Type.String({ description: "file caption (file mode only)" })),
      asPhoto: Type.Optional(Type.Boolean({ description: "send the file as a photo (inline) instead of a document" })),
      messageThreadId: Type.Optional(
        Type.Number({ description: "thread to reply into (from the context line), if any" }),
      ),
    }),
    execute: async ({ chatId, text, path, caption, asPhoto, messageThreadId }) => {
      if ((text === undefined) === (path === undefined)) {
        throw new Error("pass exactly one of `text` (a message) or `path` (a file)");
      }
      const telegram = telegramTransport(TELEGRAM_BOT_TOKEN);
      const target = { chatId, threadId: messageThreadId };
      let said: string;
      if (text !== undefined) {
        // A file-only param alongside text would be silently dropped: the same corrective error as above.
        if (caption !== undefined || asPhoto !== undefined) {
          throw new Error("`caption`/`asPhoto` are file-mode only: with `text`, put everything in the text");
        }
        const sent = await telegram.sendText(target, text);
        const what =
          sent.messageIds.length === 1
            ? `sent message to chat ${chatId}`
            : `sent ${sent.messageIds.length} messages to chat ${chatId} (split at Telegram's length cap)`;
        said = sent.notRecorded ? `${what}; not recorded: ${sent.notRecorded}` : what;
      } else {
        const sent = await telegram.sendFile(target, { path: path as string, caption, asPhoto });
        const what = `sent ${basename(path as string)} to chat ${chatId}`;
        said = sent.notRecorded ? `${what}; not recorded: ${sent.notRecorded}` : what;
      }
      return { output: [{ type: "text", text: said }] };
    },
  }),
);
