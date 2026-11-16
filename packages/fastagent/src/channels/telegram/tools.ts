/**
 * The tools a Telegram channel gives the agent: `send`, a text or a local file to a chat, over the channel's bot, and
 * `history`, what the place a turn was asked in said, as the channel recorded it.
 */
import { basename } from "node:path";
import type { ChannelTool } from "../../channel.ts";
import { type SessionPlaces, historyTool } from "../kit/history.ts";
import type { RecentMessages } from "./recent.ts";
import type { TelegramTransport } from "./transport.ts";

interface SendArgs {
  chatId: number | string;
  text?: string;
  path?: string;
  caption?: string;
  asPhoto?: boolean;
  messageThreadId?: number;
}

/** A forum topic of the chat `place` is in. */
function topicOf(place: string, topic: string): string {
  if (!/^\d+$/.test(topic)) throw new Error(`"${topic}" is not a topic id: pass a forum topic's message_thread_id`);
  return `${place.split(":")[0]}:${topic}`;
}

export function telegramTools(
  telegram: TelegramTransport,
  mounted: () => { places: SessionPlaces; recent: RecentMessages } | undefined,
): ChannelTool[] {
  return [
    {
      name: "send",
      description:
        "Send to a Telegram chat: a text message (`text`: long text is split into multiple messages " +
        "automatically), or a local file (`path`: a document, or a photo if it is an image). Exactly one " +
        "of text/path. Use it for a message NO channel is carrying (a scheduled or self-scheduled one) " +
        "or to reach a chat OTHER than the one you are answering. In a normal chat turn the channel " +
        "already delivers your reply, so do NOT call this to answer (it would send it twice). chatId comes " +
        "from the [telegram: chat …] context line in a chat turn; a scheduled or woken message has no context " +
        "line, so name the destination in your instruction. What you send shows in that chat's history.",
      parameters: {
        type: "object",
        properties: {
          chatId: { anyOf: [{ type: "string" }, { type: "number" }], description: "target chat id" },
          text: { type: "string", description: "message text to send" },
          path: { type: "string", description: "absolute path of the local file to send" },
          caption: { type: "string", description: "file caption (file mode only)" },
          asPhoto: { type: "boolean", description: "send the file as a photo (inline) instead of a document" },
          messageThreadId: { type: "number", description: "thread to reply into (from the context line), if any" },
        },
        required: ["chatId"],
        additionalProperties: false,
      },
      async execute(args) {
        const { chatId, text, path, caption, asPhoto, messageThreadId } = args as unknown as SendArgs;
        if ((text === undefined) === (path === undefined)) {
          throw new Error("pass exactly one of `text` (a message) or `path` (a file)");
        }
        const target = { chatId, ...(messageThreadId === undefined ? {} : { threadId: messageThreadId }) };
        if (text !== undefined) {
          // A file-only param alongside text would be silently dropped.
          if (caption !== undefined || asPhoto !== undefined) {
            throw new Error("`caption`/`asPhoto` are file-mode only: with `text`, put everything in the text");
          }
          const sent = await telegram.sendText(target, text);
          const what =
            sent.messageIds.length === 1
              ? `sent message to chat ${chatId}`
              : `sent ${sent.messageIds.length} messages to chat ${chatId} (split at Telegram's length cap)`;
          return sent.notRecorded ? `${what}; not recorded: ${sent.notRecorded}` : what;
        }
        const file = path as string;
        const sent = await telegram.sendFile(target, {
          path: file,
          ...(caption === undefined ? {} : { caption }),
          ...(asPhoto === undefined ? {} : { asPhoto }),
        });
        const what = `sent ${basename(file)} to chat ${chatId}`;
        return sent.notRecorded ? `${what}; not recorded: ${sent.notRecorded}` : what;
      },
    },
    historyTool(
      "telegram",
      () => mounted()?.places,
      async (place, { limit, threadId }) => {
        const recent = mounted()?.recent;
        if (recent === undefined) throw new Error("the telegram channel is not serving in this process");
        return recent.read(threadId === undefined ? place : topicOf(place, threadId), limit);
      },
      "a forum topic's id (message_thread_id) in this chat, to read that topic; omit it to read where you are answering",
    ),
  ];
}
