/**
 * Where a NEW thread starts from: a fork of the session that holds the message the
 * thread was opened on, at the exchange that message belongs to, or an empty session when nothing names one. A thread
 * that already exists is left alone.
 *
 * The message names an ask: a channel sends a user's chat message with its platform id as the `idempotencyKey`, so
 * `messages.get({ sessionId, idempotencyKey })` finds what it became. The thread forks at that ask's answer; at its own
 * entry when it has none (still running, or ended without one); at the session's present when it is still queued, or
 * was never taken, since it is not in the history.
 */
import { type Agent, AgentError, type Message } from "../../agent-api.ts";
import type { ForkSource } from "../../channel.ts";

/** The entry a thread forks at for the ask `message`; undefined forks at the session's present. */
function forkPoint(message: Message): string | undefined {
  if (message.status === "queued") return undefined;
  return message.answer?.entryId ?? message.entryId;
}

/**
 * What `sessionFor`'s `forkFrom` answers for a thread opened on the exchange of `ask` in `sessionId`. Nothing to fork when
 * the session is unknown or never held the ask (its turn failed before the send, or the session was replaced): the
 * thread starts empty. Rejects when the Agent cannot say.
 */
export async function threadForkSource(agent: Agent, sessionId: string | undefined, ask: string): Promise<ForkSource> {
  if (sessionId === undefined) return undefined;
  const message = await agent.messages.get({ sessionId, idempotencyKey: ask }).catch((error: unknown) => {
    if (error instanceof AgentError && error.code === "not_found") return undefined;
    throw error;
  });
  if (message === undefined) return undefined;
  const entryId = forkPoint(message);
  return { sessionId, ...(entryId === undefined ? {} : { entryId }) };
}
