/** Lightweight Slack emoji ack on the user's triggering message: 👀 while working, ✅ when done.
 *  Every failure is non-fatal — the turn's threaded reply is the real deliverable. */
import { log } from "../../log.ts";
import type { SlackApi } from "./slack-api.ts";

const EMOJI_RE = /^(?:[a-z0-9_+-]+)(?:::skin-tone-[2-6])?$/;

/** Normalize a Slack emoji name (strip surrounding colons, lowercase); return null if invalid. */
export function normalizeSlackEmojiName(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  const name = trimmed.startsWith(":") && trimmed.endsWith(":") ? trimmed.slice(1, -1) : trimmed;
  return EMOJI_RE.test(name) ? name : null;
}

export interface SlackReactionEmojis {
  processing: string;
  completed: string;
}

/** Resolve the configured reaction emojis; `false` disables the ack, invalid names throw at construction. */
export function resolveReactionEmojis(
  reactionAck: false | { processing?: string; completed?: string },
): SlackReactionEmojis | undefined {
  if (reactionAck === false) return undefined;
  const pick = (value: string | undefined, fallback: string, field: string): string => {
    if (value === undefined) return fallback;
    const name = normalizeSlackEmojiName(value);
    if (!name) throw new Error(`slackChannel reactionAck.${field} is not a valid Slack emoji name: "${value}"`);
    return name;
  };
  return {
    processing: pick(reactionAck.processing, "eyes", "processing"),
    completed: pick(reactionAck.completed, "white_check_mark", "completed"),
  };
}

export interface SlackReactionSession {
  complete(): Promise<void>;
  remove(): Promise<void>;
}

const NO_REACTION: SlackReactionSession = {
  complete: async () => undefined,
  remove: async () => undefined,
};

/** Add the processing emoji now; return a session to swap it for the completed emoji or remove it. */
export async function startSlackReaction(args: {
  api: Pick<SlackApi, "addReaction" | "removeReaction">;
  channelId: string;
  ts: string;
  emojis: SlackReactionEmojis;
  label: string;
}): Promise<SlackReactionSession> {
  const { api, channelId, ts, emojis, label } = args;
  try {
    await api.addReaction(channelId, ts, emojis.processing);
  } catch (error) {
    log.warn(`${label} could not add the processing reaction (skipping ack): ${String(error)}`);
    return NO_REACTION;
  }
  let active = true;
  const removeProcessing = async (): Promise<void> => {
    if (!active) return;
    active = false;
    await api
      .removeReaction(channelId, ts, emojis.processing)
      .catch((error) => log.warn(`${label} could not remove the processing reaction: ${String(error)}`));
  };
  return {
    complete: async () => {
      await removeProcessing();
      await api
        .addReaction(channelId, ts, emojis.completed)
        .catch((error) => log.warn(`${label} could not add the completed reaction: ${String(error)}`));
    },
    remove: removeProcessing,
  };
}
