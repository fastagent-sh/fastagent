/**
 * Which journal entries are POSITIONS and which are the control plane's own bookkeeping.
 *
 * pi's journal has one shape for everything, so the plane writes what it needs to remember into the
 * same log the conversation lives in: what fork a record is, and the anchor that makes a leaf move
 * survive a reopen. Both the record store and the history copier have to agree on which is which —
 * one publishes and navigates, the other copies — and a disagreement is invisible until a fork comes
 * back missing something. Hence one module, imported by both, depending on neither.
 */
import type { SessionManager } from "@earendil-works/pi-coding-agent";

/** "This record is a fork of X at Y." Its own entry rather than pi's header `parentSession`, which
 *  pi fills from its own fork path and names a FILE, not the branch point idempotency needs. */
const FORK_PROVENANCE = "fastagent.fork";

/** What pins a leaf move to disk. pi's `branch()` writes nothing — the leaf is runtime state, and
 *  `open()` puts it back on the file's last entry — so a move that no other write follows is
 *  forgotten. Carries no data: its PARENT is the position, which is the whole point of appending it. */
export const LEAF_ANCHOR = "fastagent.leaf";

/**
 * The CONTROL PLANE's bookkeeping — not a place in a conversation, so never published, never
 * navigable, and never copied by a fork: these describe THIS record, not the history it holds.
 *
 * An EXACT list, not a `fastagent` prefix. The prefix was tried and was wrong for one entry, at a
 * cost worth remembering: `fastagent:tool-activation` is written by the ENGINE and is thread history
 * (which deferred tools this conversation discovered), so matching it here dropped it from every
 * fork and every inherited thread — while the assistant messages that call those tools came along.
 * A new marker joins this list deliberately, which is the point of it being a list.
 */
export function isPlaneMarker(entry: { type?: string; customType?: string }): boolean {
  return entry.type === "custom" && (entry.customType === FORK_PROVENANCE || entry.customType === LEAF_ANCHOR);
}

/** Every position a client may move the branch head to, and everything `entries()` publishes — ONE
 *  predicate, so "anything published is navigable" holds by construction. `label` is metadata ABOUT
 *  an entry rather than a place; {@link isPlaneMarker} is ours rather than the conversation's. */
export function isNavigable(entry: { type?: string; customType?: string }): boolean {
  return entry.type !== "label" && !isPlaneMarker(entry);
}

/**
 * The head a client SEES: the last publishable entry on the active path.
 *
 * Not pi's leaf, which may be a marker — a solo leaf move anchors itself with one — so reporting
 * pi's answer would hand back an id the client did not ask for and cannot find in `entries()`.
 */
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

/** What fork this record IS, or undefined for a record that was not forked. The LAST stamp wins — a
 *  fork of a fork carries its own — and the whole journal is read rather than the active path, so a
 *  later leaf move cannot make a fork stop being one. */
export function forkProvenance(record: SessionManager): string | undefined {
  let found: string | undefined;
  for (const raw of record.getEntries() as { type?: string; customType?: string; data?: unknown }[]) {
    if (raw.type !== "custom" || raw.customType !== FORK_PROVENANCE) continue;
    const value = (raw.data as { provenance?: unknown } | undefined)?.provenance;
    if (typeof value === "string") found = value;
  }
  return found;
}
