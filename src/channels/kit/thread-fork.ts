/**
 * Where a NEW thread starts from (participant-model.md §5, agent-service.md §8.3): a fork of the room's session at
 * the run the thread's reply chain names, or at the room's present when nothing in it names one. A thread that already
 * exists is left alone.
 *
 * A user's message names the run that took it by its key: a channel invokes with the platform's message id as the
 * `idempotencyKey`, so `runs.get({ idempotencyKey })` finds it. The thread forks at that run's answer; at the message
 * that started it when it has none (still running, or ended without one); at the room's present when it is still
 * queued, since its message is not in the history yet.
 */
import { log } from "../../log.ts";
import type { Agent, RunStatus } from "../../protocol.ts";

/** A reply chain is ids walked from the platform, each one a `runs.get`: bounded like ids, not payloads. */
const MAX_CHAIN = 16;
const MAX_ID_CHARS = 128;

/** The entry a thread forks at for the run a chain message names; undefined forks at the room's present. */
function forkPoint(run: RunStatus): string | undefined {
  if (run.status === "queued") return undefined;
  if (run.status === "done" && run.answer) return run.answer.entryId;
  return run.messages[0]?.entryId;
}

/** Where the first run the chain names (nearest first) puts the fork; undefined, the room's present. */
async function branchPoint(agent: Agent, room: string, chain: readonly string[]): Promise<string | undefined> {
  const usable = chain.filter((id) => id.length > 0 && id.length <= MAX_ID_CHARS).slice(0, MAX_CHAIN);
  for (const idempotencyKey of usable) {
    const run = await agent.sessions.get(room).runs.get({ idempotencyKey });
    if (run) return forkPoint(run);
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
