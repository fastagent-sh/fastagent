/**
 * What a Telegram place said, kept by the channel: the Bot API cannot read a chat's history, so the channel records each
 * message it receives in a place (a chat, or a forum topic in one) and each one the agent sends there, the newest
 * {@link KEPT_PER_PLACE} of each, and the `history` tool reads them back. A place is a file of its own, written before
 * the update is acknowledged: an acknowledged update is not delivered again.
 */
import { join } from "node:path";
import { log } from "../../log.ts";
import { truncateCodePointPrefix } from "../kit/text.ts";
import { ensureStateHome, loadStateFile, saveStateFile } from "../../state-file.ts";
import type { PlaceRead } from "../kit/history.ts";

const KEPT_PER_PLACE = 200;

/** How much of one message a place keeps: a digest runs to thousands of characters. */
export const RECORDED_MAX_CHARS = 2000;

export interface RecordedMessage {
  id: number;
  from: string;
  text: string;
  /** The agent sent it. */
  own?: true;
  replyTo?: number;
}

export interface RecentMessages {
  /** Record a message, once: an update delivered again is not recorded twice. Throws when it could not be kept. */
  push(place: string, message: RecordedMessage): void;
  /** The place's newest `limit` messages. */
  read(place: string, limit: number): PlaceRead;
}

/** A message the agent sent, as its place records it. */
export function ownMessage(text: string, id: number): RecordedMessage {
  const body = truncateCodePointPrefix(text.replace(/\s+/g, " ").trim(), RECORDED_MAX_CHARS, " … (truncated)");
  return { id, from: "you", text: body, own: true };
}

function isRecorded(value: unknown): value is RecordedMessage {
  const message = value as RecordedMessage | null;
  return (
    typeof message?.id === "number" &&
    typeof message.from === "string" &&
    typeof message.text === "string" &&
    (message.own === undefined || message.own === true) &&
    (message.replyTo === undefined || typeof message.replyTo === "number")
  );
}

export function createRecentMessages(dir: string, label: string): RecentMessages {
  const places = new Map<string, RecordedMessage[]>();
  const fileOf = (place: string): string => join(dir, `${encodeURIComponent(place)}.json`);
  const load = (place: string): RecordedMessage[] => {
    const kept = places.get(place);
    if (kept !== undefined) return kept;
    const raw = loadStateFile(fileOf(place));
    const messages = Array.isArray(raw) && raw.every(isRecorded) ? raw : [];
    if (raw !== undefined && messages !== raw) {
      log.warn(`${label} unexpected shape in ${fileOf(place)}: the history of place ${place} starts empty`);
    }
    places.set(place, messages);
    return messages;
  };
  return {
    push(place, message) {
      const kept = load(place);
      // A message id counts within its chat, the agent's own messages included.
      if (kept.some((other) => other.id === message.id)) return;
      const messages = [...kept, message].slice(-KEPT_PER_PLACE);
      ensureStateHome(dir);
      saveStateFile(fileOf(place), messages);
      places.set(place, messages);
    },
    read(place, limit) {
      const messages = load(place);
      return {
        messages: messages.slice(-limit).map((message) => ({
          id: String(message.id),
          from: { kind: message.own ? "self" : "human", label: message.own ? "you" : message.from },
          text: message.text,
          ...(message.replyTo === undefined ? {} : { replyTo: String(message.replyTo) }),
        })),
        earlier: messages.length > limit,
      };
    },
  };
}
