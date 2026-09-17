/**
 * The ONE reading of a pi record's journal as neutral {@link SessionEntry} values.
 *
 * Two planes ask it the same question about the same record: the control plane's `entries()` (a client backfilling
 * over the wire) and every OFFLINE reader (`schedule history`, which opens the record directly with no serve
 * running). Deriving the projection twice is how they come to describe one record differently.
 */
import type { SessionEntry as PiSessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import type { Json } from "../../agent.ts";
import type { SessionEntries, SessionEntry } from "../../session.ts";
import { isNavigable, publishedLeaf } from "./session-markers.ts";

/** Concatenated plain text of a message's content blocks (the L0 rendering payload). A custom
 *  AgentMessage role may carry no `content` at all — that reads as empty, not a crash. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

/**
 * pi `PiSessionEntry` → neutral {@link SessionEntry}. Message entries map onto the guaranteed
 * kind vocabulary (user/assistant/tool) with a minimal render payload; every other engine record
 * keeps its pi type as an open-set kind with an EMPTY payload — present so `parentId` chains and
 * cursors stay intact, skippable by contract, and no pi message class leaks through the adapter.
 */
function toSessionEntry(entry: PiSessionEntry, parentId?: string): SessionEntry {
  const base = {
    id: entry.id,
    parentId,
    timestamp: Date.parse(entry.timestamp),
  };
  if (entry.type === "message") {
    const m = entry.message;
    if (m.role === "user") return { ...base, kind: "user", data: { text: textOf(m.content) } };
    if (m.role === "assistant") {
      const toolCalls = (m.content as Array<{ type: string; id?: string; name?: string }>)
        .filter((b) => b.type === "toolCall")
        .map((b) => ({ id: b.id ?? "", name: b.name ?? "" }));
      const data: Json = { text: textOf(m.content) };
      if (toolCalls.length > 0) (data as { toolCalls?: Json }).toolCalls = toolCalls;
      // WHY a turn ended badly, which exists nowhere else durable: the scheduler's claim carries the outcome word and
      // no reason, and the reason is otherwise a log line under the host's retention.
      const errorMessage = (m as { errorMessage?: unknown }).errorMessage;
      if (typeof errorMessage === "string" && errorMessage !== "") {
        (data as { errorMessage?: Json }).errorMessage = errorMessage;
      }
      return { ...base, kind: "assistant", data };
    }
    if (m.role === "toolResult") {
      return {
        ...base,
        kind: "tool",
        data: {
          toolCallId: m.toolCallId,
          toolName: m.toolName,
          isError: m.isError ?? false,
          text: textOf(m.content),
        },
      };
    }
    // A custom AgentMessage role (channel/extension-defined): open-set kind, skippable.
    return { ...base, kind: `message:${(m as { role: string }).role}`, data: {} };
  }
  return { ...base, kind: entry.type, data: {} };
}

/** Every published entry of one record, in append order, plus the head a client sees. */
export function readJournal(record: SessionManager): SessionEntries {
  // LEAF FIRST, then the journal: `getEntries()` hands back a SNAPSHOT, so reading it first
  // would race any concurrent append into a leaf the snapshot cannot contain — a live turn
  // reading as a dangling head. This order makes the journal a superset of the leaf's chain,
  // which is what lets the published head be trusted as one of the published entries.
  const leafEntryId = publishedLeaf(record);
  const journal = record.getEntries() as unknown as PiSessionEntry[];
  // The published tree must be SELF-CONTAINED: a `parentId` pointing at an entry this plane does
  // not publish (a label, one of our markers) would break the walk a client does from
  // `leafEntryId` upward — it would stop at an id it cannot look up and report a short path.
  // So a skipped entry is spliced out: its children point at the nearest published ancestor.
  const byId = new Map(journal.map((e) => [e.id, e]));
  const publishedParent = (entry: PiSessionEntry): string | undefined => {
    let parent = entry.parentId ?? undefined;
    while (parent) {
      const found = byId.get(parent);
      // A gap in the chain is left as a gap — `state()` reports it and the next invoke fails on
      // it (design §7); inventing a parent here would hide a corrupt journal.
      if (!found) return parent;
      if (isNavigable(found)) return parent;
      parent = found.parentId ?? undefined;
    }
    return undefined;
  };
  const entries = journal.filter(isNavigable).map((e) => toSessionEntry(e, publishedParent(e)));
  return { entries, ...(leafEntryId ? { leafEntryId } : {}) };
}
