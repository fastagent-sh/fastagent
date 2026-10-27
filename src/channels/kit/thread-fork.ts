/**
 * Where a NEW thread starts from (participant-model.md §5, architecture.md §2): a fork of the room's session at
 * the message the thread's reply chain names, or at the room's present when nothing in it names one. A thread that
 * already exists is left alone.
 *
 * A user's chat message names the message it became by its key: a channel invokes with the platform's message id as
 * the `idempotencyKey`, so `getMessage(room, { idempotencyKey })` finds it. The thread forks at that message's
 * answer; at its own entry when it has none (still taken, or done without one); at the room's present when it is still
 * queued, or was never taken, since it is not in the history.
 */
import { type Agent, AgentRejection, type MessageStatus } from "../../agent-api.ts";

/** A reply chain is ids walked from the platform, each one a `getMessage`: bounded like ids, not payloads. */
const MAX_CHAIN = 16;
const MAX_ID_CHARS = 128;

/** The entry a thread forks at for the message a chain names; undefined forks at the room's present. */
function forkPoint(message: MessageStatus): string | undefined {
  if (message.status === "queued") return undefined;
  if (message.status === "done" && message.answer) return message.answer.entryId;
  return message.entryId;
}

/** Where the first message the chain names (nearest first) puts the fork; undefined, the room's present. */
async function branchPoint(agent: Agent, room: string, chain: readonly string[]): Promise<string | undefined> {
  const usable = chain.filter((id) => id.length > 0 && id.length <= MAX_ID_CHARS).slice(0, MAX_CHAIN);
  for (const idempotencyKey of usable) {
    const message = await agent.getMessage(room, { idempotencyKey });
    if (message) return forkPoint(message);
  }
  return undefined;
}

/**
 * A new thread's session: a fork of its room's session at the message the thread's reply chain names, or at the room's
 * present when nothing in it names one; an empty session when the room has none, since nothing was said there yet.
 */
export async function forkThread(
  agent: Agent,
  thread: { room: string | undefined; chain: readonly string[] },
): Promise<string> {
  const { room, chain } = thread;
  const at = room === undefined ? undefined : await branchPoint(agent, room, chain);
  const created = await agent.createSession(
    room === undefined ? {} : { from: { sessionId: room, ...(at === undefined ? {} : { entryId: at }) } },
  );
  if (!created.ok) {
    const from = room === undefined ? "" : ` from ${room}`;
    throw new AgentRejection({
      ...created.error,
      message: `starting a thread${from} failed: ${created.error.message}`,
    });
  }
  return created.sessionId;
}
