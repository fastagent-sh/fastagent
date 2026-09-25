/**
 * Where a NEW thread starts from, when it names a parent — participant-model.md §5's rule ("a thread starts from what
 * the room knew"), on pi's `SessionManager`.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  type CompactionEntry,
  type ContextEditEntry,
  type SessionManager,
  estimateTokens,
} from "@earendil-works/pi-coding-agent";
import { log } from "../../log.ts";
import { isConversationMessage, isPlaneMarker } from "./session-markers.ts";

/** What a Caller names when a new session should start from an existing one. */
export interface SessionInheritance {
  parentSession: string;
  /**
   * Opaque markers that MAY locate the branch point on the parent's active path (searched in message content, first
   * hit wins, most recent occurrence).
   */
  branchHints?: string[];
}

/** Inheritance window: at most this many exchanges of the parent reach the child's model context. */
const INHERIT_MAX_EXCHANGES = 50;
/** …and at most roughly this many tokens (~1/4 of a 200K context: generous, not everything). */
const INHERIT_MAX_TOKENS = 50_000;
/**
 * Branch hints are IDS, not payloads: each one costs a scan over the parent's serialized path, and the wire accepts
 * arbitrary arrays.
 */
const MAX_BRANCH_HINTS = 16;
const MAX_BRANCH_HINT_CHARS = 128;

/** A pi session entry, read loosely: this module only needs the tree fields and a message payload. */
type Entry = {
  type: string;
  id: string;
  parentId: string | null;
  message?: AgentMessage;
};

function isUserMessage(entry: Entry | undefined): boolean {
  return entry?.type === "message" && entry.message?.role === "user";
}

/** Find the fork target on the parent's active path. */
function locateBranchPoint(path: Entry[], hints: string[]): string | undefined {
  const usable = hints
    .filter((hint) => hint.length > 0 && hint.length <= MAX_BRANCH_HINT_CHARS)
    .slice(0, MAX_BRANCH_HINTS);
  if (usable.length < hints.length) {
    log.warn(
      `[fastagent] ignored ${hints.length - usable.length} branch hint(s) (over ${MAX_BRANCH_HINTS} hints or ${MAX_BRANCH_HINT_CHARS} chars each) — hints are message ids, not payloads`,
    );
  }
  if (usable.length === 0) return undefined;
  // Serialize each conversation message ONCE — the scan is hints × entries, and stringify must not sit in the inner
  // loop. A hint is something a participant said, so the engine's own system entries are not searched: see
  // `isConversationMessage` for what a hint landing in the assembled prompt would otherwise do here.
  const serialized = path.map((entry) => (isConversationMessage(entry) ? JSON.stringify(entry.message) : ""));
  for (const hint of usable) {
    for (let i = path.length - 1; i >= 0; i--) {
      if (!serialized[i]?.includes(hint)) continue;
      let j = i + 1;
      while (j < path.length && !isUserMessage(path[j])) j++;
      return path[j - 1]?.id;
    }
  }
  return undefined;
}

/**
 * Bound what the child's MODEL CONTEXT starts with. Measured on pi's projection, what the model will actually see:
 * a `context_edit` omission (an abandoned retry or overflow attempt) costs nothing, and the engine's own `system`
 * entries are not history. The newest copied compaction (its summary, then the tail it retained) reaches the model
 * only while no window is cut: pi reads the NEWEST compaction alone, so a mark placed after it drops that tail. Its
 * summary, a few hundred tokens covering everything older, is carried into the mark instead.
 */
function markInheritanceWindow(child: SessionManager): void {
  const path = child.getBranch();
  const position = new Map(path.map((entry, i) => [entry.id, i]));
  const latest = path.map((entry) => entry.type).lastIndexOf("compaction");
  const previous = latest >= 0 ? (path[latest] as CompactionEntry) : undefined;
  let summaryTokens = 0;
  let tailTokens = 0;
  let tailExchanges = 0;
  const scanned: { id: string; tokens: number; startsExchange: boolean }[] = [];
  for (const { sourceEntry, messages } of child.buildSessionProjection().entries) {
    const tokens = messages.reduce(
      (sum, message) => (message.role === "system" ? sum : sum + estimateTokens(message)),
      0,
    );
    const startsExchange = sourceEntry.type === "message" && sourceEntry.message.role === "user" && messages.length > 0;
    if (sourceEntry.id === previous?.id) summaryTokens += tokens;
    else if ((position.get(sourceEntry.id) ?? -1) < latest) {
      // The retained tail: journal entries BEFORE the compaction that pi still projects.
      tailTokens += tokens;
      if (startsExchange) tailExchanges++;
    } else scanned.push({ id: sourceEntry.id, tokens, startsExchange });
  }
  const starts: number[] = [];
  scanned.forEach((entry, i) => {
    if (entry.startsExchange) starts.push(i);
  });
  if (starts.length === 0) return; // no exchange after the compaction to place a mark at
  const suffixTokens = new Array<number>(scanned.length + 1).fill(0);
  for (let i = scanned.length - 1; i >= 0; i--) {
    suffixTokens[i] = (suffixTokens[i + 1] ?? 0) + (scanned[i]?.tokens ?? 0);
  }
  const fits = (exchanges: number, tokens: number) =>
    exchanges <= INHERIT_MAX_EXCHANGES && tokens <= INHERIT_MAX_TOKENS;
  const everything = summaryTokens + tailTokens + (suffixTokens[0] ?? 0);
  if (fits(tailExchanges + starts.length, everything)) return; // the whole visible history fits the window
  // Cut: the tail goes, the summary stays (carried below). The newest exchange is the floor.
  let chosen = starts.length - 1;
  for (let k = starts.length - 2; k >= 0; k--) {
    if (!fits(starts.length - k, summaryTokens + (suffixTokens[starts[k] ?? 0] ?? 0))) break;
    chosen = k;
  }
  // Without a compaction, a mark at the first exchange would hide nothing that costs tokens.
  if (!previous && chosen === 0) return;
  const boundary = scanned[starts[chosen] ?? 0];
  if (boundary === undefined) return;
  const hidden = tailExchanges + chosen;
  const note =
    hidden > 0
      ? `Inherited from the parent conversation; ${hidden} earlier exchange(s) are not shown.`
      : "Inherited from the parent conversation; earlier messages are not shown.";
  child.appendCompaction(previous ? `${previous.summary}\n\n${note}` : note, boundary.id, everything);
}

/** The branch point this inheritance should copy up to, and the parent's path. */
export function inheritanceCut(parent: SessionManager, branchHints?: string[]): { at: string } | undefined {
  const path = parent.getBranch() as unknown as Entry[];
  const leaf = path[path.length - 1];
  if (!leaf) return undefined; // an empty parent has nothing to inherit
  const hints = branchHints ?? [];
  const at = locateBranchPoint(path, hints);
  if (at === undefined && hints.length > 0) {
    log.warn("[fastagent] no branch hint matched in the parent session — inheriting from its present");
  }
  return { at: at ?? leaf.id };
}

/**
 * Copy the parent's path up to `at` into `child`, entry by entry — what a backend with no FILE to fork has to do
 * instead.
 */
export function copyBranchInto(parent: SessionManager, child: SessionManager, at: string): void {
  /**
   * Parent entry id → the child's id for that entry: the copy mints its own, and a compaction points BACK into the
   * path it was appended to.
   */
  const copied = new Map<string, string>();
  /** Ids of entries this copy did NOT append. */
  let unanchored: string[] = [];
  const record = (parentId: string, childId: string) => {
    for (const id of unanchored) copied.set(id, childId);
    unanchored = [];
    copied.set(parentId, childId);
  };
  for (const raw of parent.getBranch(at)) {
    const entry = raw as Entry & {
      summary?: string;
      // Bound to pi's own field so a shape change there cannot land quietly.
      firstKeptEntryId?: CompactionEntry["firstKeptEntryId"];
      customType?: string;
      content?: string | unknown[];
      display?: boolean;
      data?: unknown;
      provider?: string;
      modelId?: string;
      thinkingLevel?: string;
      tokensBefore?: number;
      details?: unknown;
      targetId?: string;
      replacement?: ContextEditEntry["replacement"];
    };
    let childId: string | undefined;
    switch (entry.type) {
      case "message":
        // Every message, INCLUDING the engine's system entries: the child starts from the prompt the parent was
        // running under, and pi diffs its own sections against it, so the thread's first request carries that
        // prompt once rather than twice.
        if (entry.message) {
          childId = child.appendMessage(entry.message as Parameters<SessionManager["appendMessage"]>[0]);
        }
        break;
      case "custom_message":
        // Model-visible history, unlike the `custom` entries below it: an extension injected it INTO the
        // conversation, and the assistant messages answering it are being copied.
        childId = child.appendCustomMessageEntry(
          entry.customType ?? "",
          entry.content as Parameters<SessionManager["appendCustomMessageEntry"]>[1],
          entry.display ?? false,
          entry.details,
        );
        break;
      case "compaction":
        // `firstKeptEntryId` is where the RETAINED TAIL starts — the entries pi did not summarize, which still reach
        // the model.
        childId = child.appendCompaction(
          entry.summary ?? "",
          copied.get(entry.firstKeptEntryId ?? "") ?? "",
          entry.tokensBefore ?? 0,
          entry.details,
        );
        break;
      case "context_edit":
        // pi omits an abandoned retry/overflow attempt from the model's context this way; dropping the edit would
        // hand that attempt back to the copy. Its target is a message, which the copy always anchors.
        if (entry.targetId && entry.replacement !== undefined) {
          const target = copied.get(entry.targetId);
          if (target) childId = child.appendContextEdit(target, entry.replacement);
        }
        break;
      case "model_change":
        if (entry.provider && entry.modelId) childId = child.appendModelChange(entry.provider, entry.modelId);
        break;
      case "thinking_level_change":
        if (entry.thinkingLevel) childId = child.appendThinkingLevelChange(entry.thinkingLevel);
        break;
      case "custom":
        // The plane's markers describe the parent's RECORD, not the thread's history.
        if (entry.customType && !isPlaneMarker(entry)) {
          childId = child.appendCustomEntry(entry.customType, entry.data);
        }
        break;
      default:
        break; // label / session_info / branch_summary: the parent's facts, not the thread's history
    }
    if (childId === undefined) unanchored.push(entry.id);
    else record(entry.id, childId);
  }
}

/** {@link copyBranchInto} plus the inheritance window — what a new THREAD gets and a fork does not. */
export function copyBranchForInheritance(parent: SessionManager, child: SessionManager, at: string): void {
  copyBranchInto(parent, child, at);
  markInheritanceWindow(child);
}

// There is deliberately NO file-level fork here. pi can copy a path into a new file (`createBranchedSession` +
// `forkFrom`), but that pair writes the intermediate only when the copied path contains an ASSISTANT message — so
// forking at a user entry hands `forkFrom` a path that does not exist, and the failure reads as retryable for a
// condition no retry can change.
