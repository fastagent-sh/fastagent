/**
 * Which journal entries are POSITIONS, which are the control plane's own bookkeeping, and which are turns in the
 * CONVERSATION. pi's journal has one shape for everything, so the plane writes what it needs to remember into the
 * same log the conversation lives in (what fork a record is, and the anchor that makes a leaf move survive a
 * reopen) — and since 0.86 the HARNESS writes its own bookkeeping there too, as the `system` entries carrying the
 * assembled prompt. Three questions, one file: a reader of the journal answers them here or it answers them alone,
 * which is how one reader came to count the prompt as history.
 */
import type { SessionManager } from "@earendil-works/pi-coding-agent";

/**
 * "This record is a fork of X at Y." Its own entry rather than pi's header `parentSession`, which pi fills from its
 * own fork path and names a FILE, not the branch point idempotency needs. Written after the copy, so it also says
 * where the copy ends: {@link inheritedEntries}.
 */
const FORK_PROVENANCE = "fastagent.fork";

/** What pins a leaf move to disk. pi's `branch()` writes nothing. */
export const LEAF_ANCHOR = "fastagent.leaf";

/**
 * `LoopPort`'s message records (loop-port.ts), as custom entries of the session's own log. Records of the log, which
 * `LoopPort` reads and never publishes; a fork leaves them out, since a fork copies history and not messages.
 */
export const MESSAGE_MARKERS = {
  message_accepted: "fastagent.message_accepted",
  message_taken: "fastagent.message_taken",
  message_ended: "fastagent.message_ended",
} as const;

const MESSAGE_MARKER_TYPES: ReadonlySet<string> = new Set(Object.values(MESSAGE_MARKERS));

export function isMessageMarker(entry: { type?: string; customType?: string }): boolean {
  return entry.type === "custom" && entry.customType !== undefined && MESSAGE_MARKER_TYPES.has(entry.customType);
}

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
 * The line it draws is the HARNESS's prompt state. Since pi 0.86 pi writes `system` messages into the same log the
 * conversation lives in, carrying the assembled prompt (system prompt, project context, skill and tool descriptions)
 * plus one more per prompt or tool-set change. They are bookkeeping, not something anyone said, and every reader
 * of the journal has to decide about them. Deciding once, here, is the point: the first reader that forgot cut
 * inheritance above every exchange and handed a new thread an empty history, with no diagnostic.
 */
export function isConversationMessage(entry: { type?: string; message?: { role?: string } }): boolean {
  return entry.type === "message" && entry.message?.role !== "system";
}

/**
 * Every position a client may move the branch head to, and everything the log publishes: ONE predicate, so "anything
 * published is navigable" holds by construction.
 */
function isNavigable(entry: { type?: string; customType?: string }): boolean {
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

/**
 * The entries a fork copied: every entry written before its provenance stamp. A record that is not a fork has none.
 */
export function inheritedEntries(entries: readonly { id: string; type?: string; customType?: string }[]): Set<string> {
  const stamp = entries.findIndex((entry) => entry.type === "custom" && entry.customType === FORK_PROVENANCE);
  return new Set(entries.slice(0, Math.max(stamp, 0)).map((entry) => entry.id));
}

/** Stamp a fresh fork, once its copy is written, with where it came from. */
export function stampProvenance(record: SessionManager, provenance: string): void {
  record.appendCustomEntry(FORK_PROVENANCE, { provenance });
}
