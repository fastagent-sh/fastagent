/**
 * A Telegram channel's transport, shared by its turns and its send tool. A message the agent sends itself (a
 * schedule's digest, a post into another chat) never comes back as an update, so once the channel is mounted it is
 * recorded into the target place's history, where the `history` tool reads it.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { log } from "../../log.ts";
import { type RecordedMessage, ownMessage } from "./recent.ts";
import { telegramPlaceKey } from "./parse.ts";
import { callApi, chunkText } from "./telegram-api.ts";

/** Where a proactive message goes: a chat, optionally a forum topic. */
interface TelegramSendTarget {
  chatId: number | string;
  threadId?: number;
}

/** What a send did. */
interface TelegramSent {
  /** One per message, in order (long text is split at Telegram's length cap). */
  messageIds: number[];
  /** Why the chat's history will NOT show this message, when it will not; undefined when it was recorded. */
  notRecorded?: string;
}

export interface TelegramTransport {
  /** Send plain text, split at Telegram's length cap. */
  sendText(target: TelegramSendTarget, text: string): Promise<TelegramSent>;
  /** Send a local file as a document, or inline as a photo. */
  sendFile(
    target: TelegramSendTarget,
    file: { path: string; caption?: string; asPhoto?: boolean },
  ): Promise<TelegramSent>;
}

const NO_MESSAGE_ID = "Telegram gave the sent message no id, so the chat's history will not show it";

const NOT_MOUNTED = "the telegram channel is not serving in this process, so the chat's history will not show it";

/**
 * The place a sent message landed in, keyed by the same fields an update is keyed by (`chat.id`,
 * `message_thread_id`): the platform's echo names the chat by number where the target named it `@channel`, and
 * omits the thread id exactly where an update in that place would. The target stands in only for a reply that names
 * no chat.
 */
function landedPlace(sent: { chat?: { id?: number }; message_thread_id?: number }, target: TelegramSendTarget): string {
  return sent.chat?.id !== undefined
    ? telegramPlaceKey(sent.chat.id, sent.message_thread_id)
    : telegramPlaceKey(target.chatId, target.threadId);
}

/**
 * The transport of the bot `botToken` signs in as. `record` is the mounted channel's history write, read at each send:
 * undefined until the channel is served in this process.
 */
export function telegramTransport(
  apiBaseUrl: string,
  botToken: string,
  record: () => ((place: string, message: RecordedMessage) => void) | undefined,
): TelegramTransport {
  /** Record what was delivered. It is already in the chat, so a failure here is reported, never thrown: a thrown send
   *  would read as "not sent" and invite a duplicate. */
  const remember = (placeKey: string, entry: RecordedMessage): string | undefined => {
    const write = record();
    if (!write) return NOT_MOUNTED;
    try {
      write(placeKey, entry);
      return undefined;
    } catch (error) {
      log.warn(`[telegram] a sent message was not recorded into place ${placeKey}: ${String(error)}`);
      return `recording it failed: ${String(error)}`;
    }
  };
  const params = (target: TelegramSendTarget): Record<string, unknown> => ({
    chat_id: target.chatId,
    ...(target.threadId !== undefined ? { message_thread_id: target.threadId } : {}),
  });

  return {
    async sendText(target, text) {
      const messageIds: number[] = [];
      let place = telegramPlaceKey(target.chatId, target.threadId);
      for (const chunk of chunkText(text, { html: false })) {
        const sent = await callApi(apiBaseUrl, botToken, "sendMessage", { ...params(target), text: chunk });
        if (sent.message_id !== undefined) messageIds.push(sent.message_id);
        place = landedPlace(sent, target);
      }
      const first = messageIds[0];
      return {
        messageIds,
        notRecorded: first === undefined ? NO_MESSAGE_ID : remember(place, ownMessage(text, first)),
      };
    },
    async sendFile(target, file) {
      const form = new FormData();
      for (const [key, value] of Object.entries(params(target))) form.set(key, String(value));
      if (file.caption) form.set("caption", file.caption);
      const name = basename(file.path);
      form.set(file.asPhoto ? "photo" : "document", new Blob([await readFile(file.path)]), name);
      const sent = await callApi(apiBaseUrl, botToken, file.asPhoto ? "sendPhoto" : "sendDocument", form);
      const label = file.asPhoto ? "[photo]" : `[document: ${name}]`;
      return {
        messageIds: sent.message_id !== undefined ? [sent.message_id] : [],
        notRecorded:
          sent.message_id === undefined
            ? NO_MESSAGE_ID
            : remember(
                landedPlace(sent, target),
                ownMessage(file.caption ? `${label} ${file.caption}` : label, sent.message_id),
              ),
      };
    },
  };
}
