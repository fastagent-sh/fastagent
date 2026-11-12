/**
 * Which conversation a platform message belongs to: the asks a channel accepted for a conversation, and what the agent
 * posted for it. A reply to one of them is steered into that conversation, whoever sends it, because its session holds
 * the exchange the reply is about, and a new thread opened on one forks that session at the exchange
 * (docs/design/place-sessions.md, "The message table and replying to an answer").
 *
 * A key names a message in its platform (the channel makes it unique: Telegram's message ids count within one chat).
 * The table only offers candidates: a message it does not hold (another bot's, one from before the agent joined, one
 * past the bound) names nothing, and the reply is an ordinary message of its sender.
 */
import { log } from "../../log.ts";
import { loadStateFile, saveStateFile } from "../../state-file.ts";

/** Messages kept, oldest dropped: a reply reaches back as far as a person scrolls, not through the history. */
const MAX_MESSAGES = 1000;

/** Whose a message is: the conversation, and the ask (its `idempotencyKey`) the exchange it belongs to began with. */
interface MessageOwner {
  conversation: string;
  /** The ask itself for an ask, the ask answered for what the agent posted; none for a post that answers no ask. */
  ask?: string;
}

export interface MessageOwners {
  /** A message that belongs to `owner`. Durable best effort: a failed write is said, and memory keeps it. */
  record(key: string, owner: MessageOwner): void;
  ownerOf(key: string): MessageOwner | undefined;
}

export function createMessageOwners(options: {
  label: string;
  path: string;
  /** Messages kept (default 1000). */
  maxMessages?: number;
}): MessageOwners {
  const { label, path, maxMessages = MAX_MESSAGES } = options;
  const owners = load(path, label);
  return {
    record(key, owner) {
      // Most recently recorded last: the map's order is the eviction order.
      owners.delete(key);
      owners.set(key, owner);
      for (const victim of [...owners.keys()].slice(0, Math.max(0, owners.size - maxMessages))) owners.delete(victim);
      try {
        saveStateFile(path, Object.fromEntries(owners));
      } catch (error) {
        log.warn(
          `${label} could not write ${path}: after a restart a reply to an earlier message is no longer steered into ` +
            `the session it names: ${String(error)}`,
        );
      }
    },
    ownerOf: (key) => owners.get(key),
  };
}

function isOwner(value: unknown): value is MessageOwner {
  const owner = value as MessageOwner | null;
  return (
    typeof owner === "object" &&
    owner !== null &&
    typeof owner.conversation === "string" &&
    (owner.ask === undefined || typeof owner.ask === "string")
  );
}

function load(path: string, label: string): Map<string, MessageOwner> {
  const raw = loadStateFile(path);
  if (raw === undefined) return new Map();
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw) && Object.values(raw).every(isOwner)) {
    return new Map(Object.entries(raw as Record<string, MessageOwner>));
  }
  log.warn(
    `${label} unexpected shape in ${path} — replies are not steered into earlier sessions until it is rewritten`,
  );
  return new Map();
}
