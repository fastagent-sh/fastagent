/**
 * Which journal entries are POSITIONS, which are the control plane's own bookkeeping, and which are turns in the
 * CONVERSATION. pi's journal has one shape for everything, so the plane writes what it needs to remember into the
 * same log the conversation lives in (what fork a record is, the anchor that makes a leaf move survive a reopen, and
 * how a user message reached its run) — and since 0.86 the ENGINE writes its own bookkeeping there too, as the
 * `system` entries carrying the assembled prompt. Three questions, one file: a reader of the journal answers them here
 * or it answers them alone, which is how one reader came to count the prompt as history.
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
 * How a user message was delivered: it started its run (`prompt`), joined it in flight (`steer`) or waited for it
 * (`follow_up`). pi's user entry carries only the message, so the plane records this in its own entry written just
 * BEFORE the message's: a user entry is published with its delivery already knowable, since a cursor never returns to
 * an entry it has passed.
 */
const DELIVERY = "fastagent.delivery";

export type Delivery = "prompt" | "steer" | "follow_up";

/**
 * The CONTROL PLANE's bookkeeping — not a place in a conversation, so never published, never navigable, and never
 * copied by a fork.
 */
export function isPlaneMarker(entry: { type?: string; customType?: string }): boolean {
  return (
    entry.type === "custom" &&
    (entry.customType === FORK_PROVENANCE || entry.customType === LEAF_ANCHOR || entry.customType === DELIVERY)
  );
}

/**
 * An entry that is a TURN IN THE CONVERSATION — what a reader counting, previewing or searching the history means
 * by "a message".
 *
 * The line it draws is the ENGINE's prompt state. Since pi 0.86 pi writes `system` messages into the same log the
 * conversation lives in, carrying the assembled prompt (persona, project context, skill and tool descriptions)
 * plus one more per prompt or tool-set change. They are bookkeeping, not something anyone said, and every reader
 * of the journal has to decide about them. Deciding once, here, is the point: the first reader that forgot cut
 * inheritance above every exchange and handed a new thread an empty history, with no diagnostic.
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

/** Record the delivery of the user message pi is about to journal, named by its timestamp. */
export function recordDelivery(record: SessionManager, delivery: Delivery, timestamp: number): void {
  record.appendCustomEntry(DELIVERY, { delivery, timestamp });
}

/**
 * Every recorded delivery in a journal (append order), by user entry id. A record applies to the next conversation
 * message after it, and only if that is the user message it names (its timestamp): a record whose message was never
 * journaled (a process that died in between) applies to nothing, not to the next user message to come. A user entry
 * with no record (written before deliveries were recorded, or a turn an extension started) is absent: unknown, not a
 * prompt.
 */
export function readDeliveries(
  entries: readonly {
    id: string;
    type?: string;
    customType?: string;
    data?: unknown;
    message?: { role?: string; timestamp?: number };
  }[],
): Map<string, Delivery> {
  const found = new Map<string, Delivery>();
  let pending: { delivery: Delivery; timestamp: unknown } | undefined;
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === DELIVERY) {
      const data = entry.data as { delivery?: unknown; timestamp?: unknown } | undefined;
      const delivery = data?.delivery;
      pending =
        delivery === "prompt" || delivery === "steer" || delivery === "follow_up"
          ? { delivery, timestamp: data?.timestamp }
          : undefined;
    } else if (isConversationMessage(entry)) {
      if (pending && entry.message?.role === "user" && entry.message.timestamp === pending.timestamp) {
        found.set(entry.id, pending.delivery);
      }
      pending = undefined;
    }
  }
  return found;
}
