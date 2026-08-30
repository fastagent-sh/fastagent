/**
 * Where a NEW thread starts from, when it names a parent — participant-model.md §5's rule ("a thread
 * starts from what the room knew"), on pi's `SessionManager`.
 *
 * Shape: copy the parent's ACTIVE PATH up to the branch point (everything — text, images, tool
 * results — because they are entries, not prompt text), then bound what the MODEL sees with one
 * mechanical compaction mark (a plain string; zero model calls). Disk keeps the full copy — storage
 * and context are different budgets — and pi honors the mark exactly as it honors a real compaction.
 *
 * Read ONLY on the create path. An existing session ignores it entirely, which is what makes
 * inheritance one-time by construction: no marker to persist, no decision to retry per turn; the
 * session existing IS the record that the decision was taken.
 *
 * Every failure lands on "start empty + warn": a thread must not lose its first turn to an
 * inheritance edge.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { log } from "../../log.ts";
import { isPlaneMarker } from "./session-markers.ts";

/** What a Caller names when a new session should start from an existing one. */
export interface SessionInheritance {
  /** The session to inherit from. Missing or unreadable → start empty, with a warn: context is not
   *  the ask, and losing it must not cost the turn. */
  parentSession: string;
  /** Opaque markers that MAY locate the branch point on the parent's active path (searched in
   *  message content, first hit wins, most recent occurrence). No match → the parent's present. */
  branchHints?: string[];
}

/** Inheritance window: at most this many exchanges of the parent reach the child's model context. */
const INHERIT_MAX_EXCHANGES = 50;
/** …and at most roughly this many tokens (~1/4 of a 200K context: generous, not everything). Both
 *  limits govern how far the window EXTENDS into older history — the newest exchange is a FLOOR,
 *  kept whole even when it alone exceeds the budget: the mark's boundary is entry-granular, and an
 *  inheritance that drops the exchange the thread branched off would be no inheritance at all. */
const INHERIT_MAX_TOKENS = 50_000;
/** Branch hints are IDS, not payloads: each one costs a scan over the parent's serialized path, and
 *  the wire accepts arbitrary arrays — so the engine caps them where the cost lives. */
const MAX_BRANCH_HINTS = 16;
const MAX_BRANCH_HINT_CHARS = 128;
/** A vision image is priced FLAT — what a provider bills for a resized image, roughly — because its
 *  base64 length (~1M chars for a photo) measures storage, not context: pricing it by chars would
 *  let one photo evict the whole text window. */
const INHERIT_IMAGE_TOKENS = 1_600;

/** A pi session entry, read loosely: this module only needs the tree fields and a message payload. */
type Entry = {
  type: string;
  id: string;
  parentId: string | null;
  message?: AgentMessage;
  content?: string | unknown[];
  summary?: string;
  firstKeptEntryId?: string;
};

function isUserMessage(entry: Entry | undefined): boolean {
  return entry?.type === "message" && entry.message?.role === "user";
}

/** Rough token estimate for windowing — text at chars/4, images flat. Precision is not the point:
 *  the window is a budget, and being 20% off moves a boundary by an exchange, not correctness. */
function estimateContentTokens(content: unknown): number {
  if (typeof content === "string") return Math.ceil(content.length / 4);
  if (!Array.isArray(content)) return 0;
  let tokens = 0;
  for (const block of content as { type?: string; text?: string }[]) {
    if (block.type === "image") tokens += INHERIT_IMAGE_TOKENS;
    else if (typeof block.text === "string") tokens += Math.ceil(block.text.length / 4);
    else tokens += Math.ceil(JSON.stringify(block).length / 4);
  }
  return tokens;
}

/** Both entry kinds pi projects into model context from a copied path: a `custom_message` is an
 *  extension's injection INTO the conversation, so it charges the budget like any message. */
function estimateEntryTokens(entry: Entry): number {
  if (entry.type === "message") return estimateContentTokens((entry.message as { content?: unknown })?.content);
  if (entry.type === "custom_message") return estimateContentTokens(entry.content);
  return 0;
}

/** A compaction entry's summary AND its retained tail — the entries from `firstKeptEntryId` up to
 *  the compaction — DO reach the model. They are the floor under every window that starts above the
 *  compaction, so the budget must count them; the tail is read off the path, since pi stores it as a
 *  pointer and not as messages on the entry. */
function estimateCompactionTokens(path: Entry[], compactionIdx: number): number {
  const compaction = path[compactionIdx];
  if (compaction?.type !== "compaction") return 0;
  let tokens = Math.ceil((compaction.summary ?? "").length / 4);
  const firstKept = path.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
  if (firstKept < 0) return tokens; // an unresolvable pointer keeps nothing — pi's own reading
  for (let i = firstKept; i < compactionIdx; i++) {
    const entry = path[i];
    if (entry) tokens += estimateEntryTokens(entry);
  }
  return tokens;
}

/**
 * Find the fork target on the parent's active path: the LAST message whose content carries a hint
 * (the most recent turn that talked about that message), extended forward to the end of its exchange
 * — forking mid-exchange would inherit a question without its answer. Hints are tried in caller
 * order; the first that matches anywhere wins. No match → undefined (the caller forks the present).
 */
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
  // Serialize each message ONCE — the scan is hints × entries, and stringify must not sit in the
  // inner loop. The whole message, not just content: shape-agnostic, and a hint is a platform id —
  // a false positive would need the id to appear outside content, which is where ids live anyway.
  const serialized = path.map((entry) => (entry.type === "message" ? JSON.stringify(entry.message) : ""));
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
 * Bound what the child's MODEL CONTEXT starts with: keep the newest exchange unconditionally, extend
 * older while both window limits hold, and mark the boundary with a mechanical compaction entry.
 * Entries above the parent's own last compaction are already outside model context and need no mark;
 * a child whose visible history fits the window gets no mark at all.
 */
function markInheritanceWindow(child: SessionManager): void {
  const path = child.getBranch() as unknown as Entry[];
  let scanFrom = 0;
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i]?.type === "compaction") {
      scanFrom = i + 1;
      break;
    }
  }
  const scanned = path.slice(scanFrom);
  // The compaction's own summary + retained tail reach the model regardless of where the window
  // lands, so they charge the budget as a base cost — not estimating them would over-admit.
  const baseTokens = estimateCompactionTokens(path, scanFrom - 1);
  const starts: number[] = [];
  scanned.forEach((entry, i) => {
    if (isUserMessage(entry)) starts.push(i);
  });
  if (starts.length <= 1) return; // zero or one visible exchange — nothing to cut
  const suffixTokens = new Array<number>(scanned.length + 1).fill(0);
  for (let i = scanned.length - 1; i >= 0; i--) {
    const entry = scanned[i];
    suffixTokens[i] = (suffixTokens[i + 1] ?? 0) + (entry ? estimateEntryTokens(entry) : 0);
  }
  let chosen = starts.length - 1;
  for (let k = starts.length - 2; k >= 0; k--) {
    const exchanges = starts.length - k;
    const startIdx = starts[k];
    if (startIdx === undefined) break;
    if (exchanges > INHERIT_MAX_EXCHANGES || baseTokens + (suffixTokens[startIdx] ?? 0) > INHERIT_MAX_TOKENS) break;
    chosen = k;
  }
  if (chosen === 0) return; // the whole visible history fits the window
  const boundaryIdx = starts[chosen];
  if (boundaryIdx === undefined) return;
  const boundary = scanned[boundaryIdx];
  if (boundary === undefined) return;
  child.appendCompaction(
    `Inherited from the parent conversation; ${chosen} earlier exchange(s) are not shown.`,
    boundary.id,
    (suffixTokens[0] ?? 0) - (suffixTokens[boundaryIdx] ?? 0),
  );
}

/**
 * The branch point this inheritance should copy up to, and the parent's path — the decision half,
 * shared by both backends because WHERE a thread branches is policy, not storage.
 */
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
 * Copy the parent's path up to `at` into `child`, entry by entry — what a backend with no FILE to
 * fork has to do instead. Kinds pi models as facts about an entry rather than positions (labels,
 * the session name) are not copied: they describe the parent's record, not the thread's history.
 *
 * The COPY only. Bounding what the child's model sees is {@link markInheritanceWindow}, which only
 * {@link copyBranchForInheritance} applies: a lifecycle fork that marked a window would hide the
 * exact entries its user forked to keep.
 */
export function copyBranchInto(parent: SessionManager, child: SessionManager, at: string): void {
  /** Parent entry id → the child's id for that entry: the copy mints its own, and a compaction
   *  points BACK into the path it was appended to. */
  const copied = new Map<string, string>();
  /** Ids of entries this copy did NOT append. A compaction's `firstKeptEntryId` routinely names one:
   *  pi walks the cut point backwards onto the metadata entries adjacent to it, which carry no
   *  context. They resolve to the next entry that survived — the retained tail starts there — so a
   *  dropped anchor moves the boundary by an invisible entry instead of erasing the whole tail. */
  let unanchored: string[] = [];
  const record = (parentId: string, childId: string) => {
    for (const id of unanchored) copied.set(id, childId);
    unanchored = [];
    copied.set(parentId, childId);
  };
  for (const raw of parent.getBranch(at)) {
    const entry = raw as Entry & {
      customType?: string;
      content?: string | unknown[];
      display?: boolean;
      data?: unknown;
      provider?: string;
      modelId?: string;
      thinkingLevel?: string;
      tokensBefore?: number;
      details?: unknown;
    };
    let childId: string | undefined;
    switch (entry.type) {
      case "message":
        if (entry.message) {
          childId = child.appendMessage(entry.message as Parameters<SessionManager["appendMessage"]>[0]);
        }
        break;
      case "custom_message":
        // Model-visible history, unlike the `custom` entries below it: an extension injected it INTO
        // the conversation, and the assistant messages answering it are being copied.
        childId = child.appendCustomMessageEntry(
          entry.customType ?? "",
          entry.content as Parameters<SessionManager["appendCustomMessageEntry"]>[1],
          entry.display ?? false,
          entry.details,
        );
        break;
      case "compaction":
        // `firstKeptEntryId` is where the RETAINED TAIL starts — the entries pi did not summarize,
        // which still reach the model. Translated through the copy rather than pinned to the child's
        // leaf: pinning kept exactly ONE entry, and when that entry was a toolResult (a compaction
        // lands wherever the turn ended) the child's first request opened with a tool result whose
        // call had been summarized away, which every provider rejects. An id the copy never saw
        // keeps nothing, which is what pi itself does with a pointer it cannot resolve.
        childId = child.appendCompaction(
          entry.summary ?? "",
          copied.get(entry.firstKeptEntryId ?? "") ?? "",
          entry.tokensBefore ?? 0,
          entry.details,
        );
        break;
      case "model_change":
        if (entry.provider && entry.modelId) childId = child.appendModelChange(entry.provider, entry.modelId);
        break;
      case "thinking_level_change":
        if (entry.thinkingLevel) childId = child.appendThinkingLevelChange(entry.thinkingLevel);
        break;
      case "custom":
        // The plane's markers describe the parent's RECORD, not the thread's history: a copied
        // provenance would make a fork of a fork claim its grandparent's branch point (the
        // idempotency check reads that value), and a copied leaf anchor would pin the child's head
        // to a position its own history never chose. Every other custom entry is history and travels
        // — the engine's tool-activation delta above all, since the copied assistant messages call
        // the tools it records.
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

/** {@link copyBranchInto} plus the inheritance window — what a new THREAD gets and a fork does not.
 *  Both backends call THIS one, so neither can drift on where a child's context begins. */
export function copyBranchForInheritance(parent: SessionManager, child: SessionManager, at: string): void {
  copyBranchInto(parent, child, at);
  markInheritanceWindow(child);
}

/*
 * There is deliberately NO file-level fork here. pi can copy a path into a new file
 * (`createBranchedSession` + `forkFrom`), but that pair writes the intermediate only when the copied
 * path contains an ASSISTANT message — so forking at a user entry hands `forkFrom` a path that does
 * not exist, and the failure reads as retryable for a condition no retry can change. Copying entries
 * is what a backend with no file to fork has to do anyway, so both share these functions and one
 * semantics; a fork is not hot enough to buy a second path back.
 */
