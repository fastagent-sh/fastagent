/**
 * Where a NEW thread starts from (participant-model.md §5, architecture.md §2): a fork of the room's session at
 * the message the thread's reply chain names, or at the room's present when nothing in it names one. A thread that
 * already exists is left alone.
 *
 * A user's chat message names the message it became by its key: a channel sends with the platform's message id as
 * the `idempotencyKey`, so `messages.get({ sessionId: room, idempotencyKey })` finds it. The thread forks at that
 * message's answer; at its own entry when it has none (still running, or ended without one); at the room's present
 * when it is still queued, or was never taken, since it is not in the history.
 */
import { type Agent, AgentError, type Message } from "../../agent-api.ts";
import type { ForkSource } from "../../channel.ts";

/** A reply chain is ids walked from the platform, each one a `messages.get`: bounded like ids, not payloads. */
const MAX_CHAIN = 16;
const MAX_ID_CHARS = 128;

/** The entry a thread forks at for the message a chain names; undefined forks at the room's present. */
function forkPoint(message: Message): string | undefined {
  if (message.status === "queued") return undefined;
  return message.answer?.entryId ?? message.entryId;
}

/** Where the first message the chain names (nearest first) puts the fork; undefined, the room's present. */
async function branchPoint(agent: Agent, room: string, chain: readonly string[]): Promise<string | undefined> {
  const usable = chain.filter((id) => id.length > 0 && id.length <= MAX_ID_CHARS).slice(0, MAX_CHAIN);
  for (const idempotencyKey of usable) {
    const message = await agent.messages.get({ sessionId: room, idempotencyKey }).catch((error: unknown) => {
      // A platform message the agent was never sent (another bot's, or one before the agent joined) names nothing.
      if (error instanceof AgentError && error.code === "not_found") return undefined;
      throw error;
    });
    if (message) return forkPoint(message);
  }
  return undefined;
}

/**
 * Where a new thread's session forks from: its room's session at the message the thread's reply chain names, or at the
 * room's present when nothing in it names one. What `sessionFor`'s `forkFrom` answers for a thread.
 */
export async function threadForkSource(agent: Agent, room: string, chain: readonly string[]): Promise<ForkSource> {
  const at = await branchPoint(agent, room, chain);
  return { sessionId: room, ...(at === undefined ? {} : { entryId: at }) };
}
