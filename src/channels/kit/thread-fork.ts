/**
 * Where a NEW thread starts from (participant-model.md §5, agent-service.md §8.3): a fork of the room's session at
 * the message the thread's reply chain names, or at the room's present when nothing in it names one. A thread that
 * already exists is left alone.
 *
 * A user's chat message names the protocol message it became by its key: a channel invokes with the platform's message
 * id as the `idempotencyKey`, so `messages.get({ idempotencyKey })` finds it. The thread forks at that message's
 * answer; at its own entry when it has none (still taken, or done without one); at the room's present when it is still
 * queued, or was never taken, since it is not in the history.
 */
import { log } from "../../log.ts";
import type { Agent, MessageStatus } from "../../protocol.ts";

/** A reply chain is ids walked from the platform, each one a `messages.get`: bounded like ids, not payloads. */
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
    const message = await agent.sessions.get(room).messages.get({ idempotencyKey });
    if (message) return forkPoint(message);
  }
  return undefined;
}

/**
 * Create `sessionId` as a fork of `room` when it does not exist yet, with the recent part of the room's history as its
 * model context (`context: "recent"`). A room with no session leaves the thread to start empty, as its first invoke
 * creates it, and says so. A read that fails is thrown: taking it for "the thread exists" would start it empty for
 * good.
 */
export async function forkThread(
  agent: Agent,
  thread: { sessionId: string; room: string; chain: readonly string[] },
  label: string,
): Promise<void> {
  const { sessionId, room, chain } = thread;
  const own = await agent.sessions.get(sessionId).read({ limit: 0 });
  if (own.ok) return;
  if (own.error.code !== "not_found") throw new Error(`reading session ${sessionId} failed: ${own.error.message}`);
  const state = await agent.sessions.get(room).read({ limit: 0 });
  if (!state.ok) {
    if (state.error.code !== "not_found") throw new Error(`reading session ${room} failed: ${state.error.message}`);
    log.warn(`${label} thread ${sessionId} names ${room}, which has no session: the thread starts empty`);
    return;
  }
  if (state.state.leafEntryId === undefined) return;
  const at = await branchPoint(agent, room, chain);
  const created = await agent.sessions.create({
    sessionId,
    fork: { sessionId: room, ...(at === undefined ? {} : { entryId: at }), context: "recent" },
  });
  // Another delivery of the thread's first message created it meanwhile: it exists, which is all this asks.
  if (!created.ok && created.error.code !== "conflict") {
    throw new Error(`forking thread ${sessionId} from ${room} failed: ${created.error.message}`);
  }
}
