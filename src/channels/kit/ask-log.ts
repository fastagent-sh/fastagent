/**
 * Where a conversation's session last read to: what a turn's read of its place starts after.
 *
 * A turn folds the place's discussion into its message, so a session already holds the discussion up to the newest ask
 * it was sent. This log keeps the candidates (each ask's message key and where it stands in the place) and the Agent
 * says which one the session holds, so there is no second record of what was read to disagree with the session: an ask
 * that was never sent, or was withdrawn before the agent took it, is not in the session and is not counted.
 */
import { type Agent, AgentError, type Message } from "../../agent-api.ts";
import { log } from "../../log.ts";
import { loadStateFile, saveStateFile } from "../../state-file.ts";

/** Asks kept per conversation: the newest holds the answer, the rest are for one that was never sent. */
const ASKS_PER_CONVERSATION = 6;

/** Conversations kept, least recently asked in dropped. A dropped one reads its place's newest messages next. */
const MAX_CONVERSATIONS = 2000;

/** One ask: the key its message was sent under (the Agent's `idempotencyKey`), and where it stands in its place. */
interface Ask<C> {
  key: string;
  at: C;
}

export interface AskLog<C> {
  /** An accepted ask, before its message is sent. Durable best effort: a failed write is said, and memory keeps it. */
  record(conversation: string, ask: Ask<C>): void;
  /**
   * An ask whose read of its place failed: its message went on without the discussion, so it is not where the session
   * read to, and the next read starts from the ask before it, which reads what this one missed.
   */
  forget(conversation: string, key: string): void;
  /**
   * Where the session of `conversation` read to before `before` (any ask, with none): the position of its newest such
   * ask that the Agent holds in `sessionId`. Undefined when it holds none (a new session, a reset one, an ask that
   * failed before it was sent). Rejects when the Agent cannot say.
   */
  readTo(conversation: string, sessionId: string | undefined, before?: C): Promise<C | undefined>;
}

/**
 * Whether the session holds what the ask's message carried: the agent took it (its `user` entry exists), or is yet to
 * (it waits). A message withdrawn or refused before that is not in the session.
 */
function holdsItsAsk(message: Message): boolean {
  return message.entryId !== undefined || message.status === "queued" || message.status === "running";
}

export function createAskLog<C>(deps: {
  label: string;
  path: string;
  messages: Pick<Agent["messages"], "get">;
  isPosition(value: unknown): value is C;
  /** Negative, zero or positive as `a` is before, at or after `b`. */
  compare(a: C, b: C): number;
}): AskLog<C> {
  const { label, path, messages, compare } = deps;
  const conversations = load(path, label, deps.isPosition);

  const save = (): void => {
    try {
      saveStateFile(path, Object.fromEntries(conversations));
    } catch (error) {
      log.warn(
        `${label} could not write ${path}: after a restart a conversation's next turn reads its place's newest messages ` +
          `instead of what came after its last ask: ${String(error)}`,
      );
    }
  };

  return {
    record(conversation, ask) {
      const kept = (conversations.get(conversation) ?? []).filter((other) => other.key !== ask.key);
      kept.push(ask);
      kept.sort((a, b) => compare(a.at, b.at));
      // Most recently asked in last: the map's order is the eviction order.
      conversations.delete(conversation);
      conversations.set(conversation, kept.slice(-ASKS_PER_CONVERSATION));
      for (const victim of [...conversations.keys()].slice(0, Math.max(0, conversations.size - MAX_CONVERSATIONS))) {
        conversations.delete(victim);
      }
      save();
    },
    forget(conversation, key) {
      const kept = conversations.get(conversation);
      if (kept === undefined || !kept.some((ask) => ask.key === key)) return;
      conversations.set(
        conversation,
        kept.filter((ask) => ask.key !== key),
      );
      save();
    },
    async readTo(conversation, sessionId, before) {
      if (sessionId === undefined) return undefined;
      const earlier = (conversations.get(conversation) ?? []).filter(
        (ask) => before === undefined || compare(ask.at, before) < 0,
      );
      for (const ask of earlier.reverse()) {
        const message = await messages.get({ sessionId, idempotencyKey: ask.key }).catch((error: unknown) => {
          // Not sent into this session (it failed first, or the session was replaced): it holds nothing of it.
          if (error instanceof AgentError && error.code === "not_found") return undefined;
          throw error;
        });
        if (message !== undefined && holdsItsAsk(message)) return ask.at;
      }
      return undefined;
    },
  };
}

/**
 * Where a turn's read starts, for a turn that reads discussion: {@link AskLog.readTo}, with a failure said. A turn that
 * cannot tell reads the place's newest messages instead, which can repeat what the session holds but loses nothing, and
 * its text says so.
 */
export async function readStart<C>(
  asks: AskLog<C>,
  label: string,
  conversation: string,
  sessionId: string | undefined,
  before?: C,
): Promise<{ after?: C; unreadable?: string }> {
  try {
    const after = await asks.readTo(conversation, sessionId, before);
    return after === undefined ? {} : { after };
  } catch (error) {
    log.warn(
      `${label} could not tell where conversation ${conversation} read to; the turn reads the place's newest messages: ${String(error)}`,
    );
    return { unreadable: `(could not tell what was already read here, so some of this may repeat: ${String(error)})` };
  }
}

function load<C>(path: string, label: string, isPosition: (value: unknown) => value is C): Map<string, Ask<C>[]> {
  const raw = loadStateFile(path);
  if (raw === undefined) return new Map();
  const valid = (asks: unknown): asks is Ask<C>[] =>
    Array.isArray(asks) &&
    asks.every((ask) => typeof (ask as Ask<C>)?.key === "string" && isPosition((ask as Ask<C>).at));
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw) && Object.values(raw).every(valid)) {
    return new Map(Object.entries(raw as Record<string, Ask<C>[]>));
  }
  log.warn(`${label} unexpected shape in ${path} — every conversation reads its place's newest messages next`);
  return new Map();
}
