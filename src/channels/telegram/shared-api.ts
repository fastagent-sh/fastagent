/**
 * The ONE Telegram transport per state root a process holds: the mounted channel's, shared with the scaffolded send
 * tool, and the reason it is shared. A message the agent sends itself (a schedule's digest, a post into another chat)
 * never comes back as an update, so it is recorded into the target place's discussion here, where the channel's
 * context buffer lives, and the chat's next turn knows it was said.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { log } from "../../log.ts";
import { resolveStateRoot } from "../../paths.ts";
import { type BufferEntry, ownPostEntry } from "./context-buffer.ts";
import { telegramPlaceKey } from "./parse.ts";
import { callApi, chunkText } from "./telegram-api.ts";

/** Where a proactive message goes: a chat, optionally a forum topic. */
export interface TelegramSendTarget {
  chatId: number | string;
  threadId?: number;
}

/** What a send did. */
export interface TelegramSent {
  /** One per message, in order (long text is split at Telegram's length cap). */
  messageIds: number[];
  /** Why the chat's next turn will NOT see this message, when it will not; undefined when it was recorded. */
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

interface Mounted {
  apiBaseUrl: string;
  botToken: string;
  /** The mounted channel's buffer write; absent when no channel is mounted in this process. */
  record?: (placeKey: string, entry: BufferEntry) => void;
}

const byStateRoot = new Map<string, Mounted>();

/** The channel's transport is the authoritative one for its root; a re-mount replaces it. */
export function registerTelegramTransport(stateRoot: string, mounted: Required<Mounted>): void {
  byStateRoot.set(stateRoot, mounted);
}

const NOT_MOUNTED = "no telegram channel is mounted in this process, so the chat's next turn will not see it";

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

/** The transport of the agent whose directory is `cwd` (a tool's `ctx.cwd`). */
export function telegramTransport(cwd: string): TelegramTransport {
  const stateRoot = resolveStateRoot(cwd);
  let mounted = byStateRoot.get(stateRoot);
  if (!mounted) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) throw new Error("TELEGRAM_BOT_TOKEN is not set and no Telegram channel is mounted");
    mounted = { apiBaseUrl: "https://api.telegram.org", botToken };
    byStateRoot.set(stateRoot, mounted);
  }
  const { apiBaseUrl, botToken, record } = mounted;

  /** Record what was delivered. It is already in the chat, so a failure here is reported, never thrown: a thrown send
   *  would read as "not sent" and invite a duplicate. */
  const remember = (placeKey: string, entry: BufferEntry): string | undefined => {
    if (!record) return NOT_MOUNTED;
    try {
      record(placeKey, entry);
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
      return { messageIds, notRecorded: remember(place, ownPostEntry(text, messageIds[0])) };
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
        notRecorded: remember(
          landedPlace(sent, target),
          ownPostEntry(file.caption ? `${label} ${file.caption}` : label, sent.message_id),
        ),
      };
    },
  };
}
