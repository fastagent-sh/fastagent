/**
 * Which journal entries are POSITIONS and which are the control plane's own bookkeeping. pi's journal has one shape
 * for everything, so the plane writes what it needs to remember into the same log the conversation lives in: what fork
 * a record is, and the anchor that makes a leaf move survive a reopen.
 */
import type { SessionManager } from "@earendil-works/pi-coding-agent";

/**
 * "This record is a fork of X at Y." Its own entry rather than pi's header `parentSession`, which pi fills from its
 * own fork path and names a FILE, not the branch point idempotency needs.
 */
const FORK_PROVENANCE = "fastagent.fork";

/** What pins a leaf move to disk. pi's `branch()` writes nothing. */
export const LEAF_ANCHOR = "fastagent.leaf";

/**
 * The CONTROL PLANE's bookkeeping — not a place in a conversation, so never published, never navigable, and never
 * copied by a fork.
 */
export function isPlaneMarker(entry: { type?: string; customType?: string }): boolean {
  return entry.type === "custom" && (entry.customType === FORK_PROVENANCE || entry.customType === LEAF_ANCHOR);
}

/**
 * An entry that is a TURN IN THE CONVERSATION — what a reader counting, previewing or searching the history means
 * by "a message".
 *
 * The exclusion that needs a name: since pi 0.86 the engine writes its OWN `system` message entries into the same
 * log, carrying the assembled prompt (persona, project context, skill and tool descriptions) plus one more per
 * prompt or tool-set change. They are the engine's bookkeeping, not something anyone said, and every reader of the
 * journal has to decide about them. Deciding once, here, is the point: the first reader that forgot cut inheritance
 * above every exchange and handed a new thread an empty history, with no diagnostic.
 */
export function isConversationMessage(entry: { type?: string; message?: { role?: string } }): boolean {
  return entry.type === "message" && entry.message?.role !== "system";
}

/**
 * Every position a client may move the branch head to, and everything `entries()` publishes — ONE predicate, so
 * "anything published is navigable" holds by construction.
 */
export function isNavigable(entry: { type?: string; customType?: string }): boolean {
  return entry.type !== "label" && !isPlaneMarker(entry);
}

/** The head a client SEES: the last publishable entry on the active path. */
export function publishedLeaf(record: SessionManager): string | undefined {
  const path = record.getBranch() as unknown as { id: string; type?: string; customType?: string }[];
  for (let i = path.length - 1; i >= 0; i--) {
    const entry = path[i];
    if (entry && isNavigable(entry)) return entry.id;
  }
  return undefined;
}

/** Stamp a fresh fork with where it came from. */
export function stampProvenance(record: SessionManager, provenance: string): void {
  record.appendCustomEntry(FORK_PROVENANCE, { provenance });
}

/** What fork this record IS, or undefined for a record that was not forked. */
export function forkProvenance(record: SessionManager): string | undefined {
  let found: string | undefined;
  for (const raw of record.getEntries() as { type?: string; customType?: string; data?: unknown }[]) {
    if (raw.type !== "custom" || raw.customType !== FORK_PROVENANCE) continue;
    const value = (raw.data as { provenance?: unknown } | undefined)?.provenance;
    if (typeof value === "string") found = value;
  }
  return found;
}
