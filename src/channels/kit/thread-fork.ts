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

async function wholeHistory(agent: Agent, sessionId: string): Promise<{ entries: Entry[]; leaf?: string } | undefined> {
  const entries: Entry[] = [];
  let leaf: string | undefined;
  let after: string | undefined;
  for (;;) {
    const page = await agent.sessions.get(sessionId).read({ ...(after ? { after } : {}), limit: LIMITS.readMax });
    if (!page.ok) {
      if (page.error.code === "not_found") return undefined;
      throw new Error(`reading session ${sessionId} failed: ${page.error.message}`);
    }
    leaf = page.state.leafEntryId;
    entries.push(...page.entries);
    if (!page.next) return { entries, ...(leaf ? { leaf } : {}) };
    after = page.next;
  }
}

/**
 * Create `sessionId` as a fork of `parent` when it does not exist yet. A parent with no session leaves the thread to
 * start empty, as its first invoke creates it.
 */
export async function forkThread(
  agent: Agent,
  sessionId: string,
  parent: string,
  hints: readonly string[],
  label: string,
): Promise<void> {
  const own = await agent.sessions.get(sessionId).read({ limit: 0 });
  if (own.ok || own.error.code !== "not_found") return;
  const history = await wholeHistory(agent, parent);
  if (!history || history.entries.length === 0) return;
  const at = branchPoint(activePath(history.entries, history.leaf), hints);
  if (at === undefined && hints.length > 0) {
    log.warn(`${label} no branch hint matched in ${parent}: thread ${sessionId} starts from its present`);
  }
  const created = await agent.sessions.create({
    sessionId,
    fork: { sessionId: parent, ...(at === undefined ? {} : { entryId: at }) },
  });
  // Another delivery of the thread's first message created it meanwhile: it exists, which is all this asks.
  if (!created.ok && created.error.code !== "conflict") {
    throw new Error(`forking thread ${sessionId} from ${parent} failed: ${created.error.message}`);
  }
}
