/**
 * Where a NEW thread starts from (participant-model.md §5: "a thread starts from what the room knew"): a fork of the
 * room's session at the exchange the thread's first message replied to, or at the room's present when nothing names
 * one. A thread that already exists is left alone.
 */
import { log } from "../../log.ts";
import type { Agent, Entry } from "../../protocol.ts";
import { LIMITS } from "../../protocol.ts";

/**
 * Branch hints are platform message ids a turn's prompt carried; each one costs a scan of the room's history, so they
 * are bounded like ids, not payloads.
 */
const MAX_HINTS = 16;
const MAX_HINT_CHARS = 128;

const CONVERSATION: ReadonlySet<string> = new Set(["user_message", "assistant_message", "tool_result"]);

/** The active path of a session, oldest first: from its leaf back through each entry's parent. */
function activePath(entries: readonly Entry[], leaf: string | undefined): Entry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const path: Entry[] = [];
  for (let at = leaf ? byId.get(leaf) : undefined; at; at = at.parentEntryId ? byId.get(at.parentEntryId) : undefined) {
    path.push(at);
  }
  return path.reverse();
}

/**
 * The last conversation entry of the newest exchange a hint appears in: the hints in order, each searched from the
 * newest entry back, and the first that matches wins. Undefined when none does.
 */
export function branchPoint(path: readonly Entry[], hints: readonly string[]): string | undefined {
  const usable = hints.filter((hint) => hint.length > 0 && hint.length <= MAX_HINT_CHARS).slice(0, MAX_HINTS);
  if (usable.length < hints.length) {
    log.warn(`[fastagent] ignored ${hints.length - usable.length} branch hint(s): hints are message ids, not payloads`);
  }
  const serialized = path.map((entry) => (CONVERSATION.has(entry.kind) ? JSON.stringify(entry.data) : ""));
  for (const hint of usable) {
    for (let i = path.length - 1; i >= 0; i--) {
      if (!serialized[i]?.includes(hint)) continue;
      let end = i;
      for (let j = i + 1; j < path.length && path[j]?.kind !== "user_message"; j++) {
        if (CONVERSATION.has(path[j]?.kind ?? "")) end = j;
      }
      return path[end]?.id;
    }
  }
  return undefined;
}

/** Every entry of a session, oldest first: a read without a cursor is the newest page, so it pages back from there. */
async function wholeHistory(agent: Agent, sessionId: string): Promise<{ entries: Entry[]; leaf?: string } | undefined> {
  const pages: Entry[][] = [];
  let leaf: string | undefined;
  let before: string | undefined;
  for (;;) {
    const page = await agent.sessions.get(sessionId).read({ ...(before ? { before } : {}), limit: LIMITS.readMax });
    if (!page.ok) {
      if (page.error.code === "not_found" && before === undefined) return undefined;
      throw new Error(`reading session ${sessionId} failed: ${page.error.message}`);
    }
    if (before === undefined) leaf = page.state.leafEntryId;
    pages.unshift(page.entries);
    if (!page.prev) return { entries: pages.flat(), ...(leaf ? { leaf } : {}) };
    before = page.prev;
  }
}

/**
 * Create `sessionId` as a fork of `parent` when it does not exist yet. A parent with no session leaves the thread to
 * start empty, as its first invoke creates it, and says so. A read that fails is thrown: taking it for "the thread
 * exists" would start the thread empty for good.
 */
export async function forkThread(
  agent: Agent,
  sessionId: string,
  parent: string,
  hints: readonly string[],
  label: string,
): Promise<void> {
  const own = await agent.sessions.get(sessionId).read({ limit: 0 });
  if (own.ok) return;
  if (own.error.code !== "not_found") throw new Error(`reading session ${sessionId} failed: ${own.error.message}`);
  const forkAt = async (at: string | undefined): Promise<void> => {
    const created = await agent.sessions.create({
      sessionId,
      fork: { sessionId: parent, ...(at === undefined ? {} : { entryId: at }), context: "recent" },
    });
    // Another delivery of the thread's first message created it meanwhile: it exists, which is all this asks.
    if (!created.ok && created.error.code !== "conflict") {
      throw new Error(`forking thread ${sessionId} from ${parent} failed: ${created.error.message}`);
    }
  };
  const noParent = () =>
    log.warn(`${label} thread ${sessionId} names ${parent}, which has no session: the thread starts empty`);
  // Nothing to search for: the thread starts from the room's present, which its state alone names.
  if (hints.length === 0) {
    const room = await agent.sessions.get(parent).read({ limit: 0 });
    if (!room.ok) {
      if (room.error.code === "not_found") return noParent();
      throw new Error(`reading session ${parent} failed: ${room.error.message}`);
    }
    if (room.state.leafEntryId !== undefined) await forkAt(undefined);
    return;
  }
  // The whole room: a hint earlier in the list outranks a later one wherever each is found.
  const history = await wholeHistory(agent, parent);
  if (!history) return noParent();
  if (history.entries.length === 0) return;
  const at = branchPoint(activePath(history.entries, history.leaf), hints);
  if (at === undefined)
    log.warn(`${label} no branch hint matched in ${parent}: thread ${sessionId} starts from its present`);
  await forkAt(at);
}
