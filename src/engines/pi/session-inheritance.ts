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
import { unlinkSync } from "node:fs";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { log } from "../../log.ts";

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
  summary?: string;
  retainedTail?: AgentMessage[];
};

function isUserMessage(entry: Entry | undefined): boolean {
  return entry?.type === "message" && entry.message?.role === "user";
}

/** Rough token estimate for windowing — text at chars/4, images flat. Precision is not the point:
 *  the window is a budget, and being 20% off moves a boundary by an exchange, not correctness. */
function estimateMessageTokens(message: AgentMessage): number {
  const content = (message as { content?: unknown }).content;
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

function estimateEntryTokens(entry: Entry): number {
  return entry.type === "message" && entry.message ? estimateMessageTokens(entry.message) : 0;
}

/** A compaction entry's summary and retained tail DO reach the model — they are the floor under
 *  every window that starts above the compaction, so the budget must count them. */
function estimateCompactionTokens(entry: Entry | undefined): number {
  if (entry?.type !== "compaction") return 0;
  let tokens = Math.ceil((entry.summary ?? "").length / 4);
  for (const message of entry.retainedTail ?? []) tokens += estimateMessageTokens(message);
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
  const baseTokens = estimateCompactionTokens(path[scanFrom - 1]);
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
 */
export function copyBranchInto(parent: SessionManager, child: SessionManager, at: string): void {
  for (const raw of parent.getBranch(at)) {
    const entry = raw as Entry & {
      customType?: string;
      data?: unknown;
      provider?: string;
      modelId?: string;
      thinkingLevel?: string;
      tokensBefore?: number;
      details?: unknown;
    };
    switch (entry.type) {
      case "message":
        if (entry.message) child.appendMessage(entry.message as Parameters<SessionManager["appendMessage"]>[0]);
        break;
      case "compaction":
        child.appendCompaction(entry.summary ?? "", child.getLeafId() ?? "", entry.tokensBefore ?? 0, entry.details);
        break;
      case "model_change":
        if (entry.provider && entry.modelId) child.appendModelChange(entry.provider, entry.modelId);
        break;
      case "thinking_level_change":
        if (entry.thinkingLevel) child.appendThinkingLevelChange(entry.thinkingLevel);
        break;
      case "custom":
        if (entry.customType) child.appendCustomEntry(entry.customType, entry.data);
        break;
      default:
        break; // label / session_info / branch_summary: the parent's facts, not the thread's history
    }
  }
  markInheritanceWindow(child);
}

/**
 * Fork `parent` into a record named `id`, up to the branch point the hints locate, in `stagingDir`.
 *
 * Two pi calls rather than one, because neither alone does it: `createBranchedSession` copies
 * exactly the path to an entry but names the result with a generated id, and `forkFrom` takes an id
 * but copies everything. The intermediate is deleted; it exists for one call.
 *
 * STAGED, not published: the caller finishes the record (crash reconciliation) and moves it into
 * place. Publishing here and finishing after would leave a half-prepared record under the id on any
 * later failure — and the fallback path would then create a SECOND record with the same id, making
 * which one a lookup finds a matter of directory order.
 *
 * Returns undefined when inheritance cannot be honored — the caller starts the session empty.
 */
export function forkForInheritance(options: {
  parent: SessionManager;
  id: string;
  cwd: string;
  stagingDir: string;
  branchHints?: string[];
}): SessionManager | undefined {
  const { parent, id, cwd, stagingDir: dir } = options;
  const cut = inheritanceCut(parent, options.branchHints);
  if (!cut) return undefined;
  let branched: string | undefined;
  try {
    branched = parent.createBranchedSession(cut.at);
    if (!branched) return undefined; // a non-persisting parent has no file to fork from
    const child = SessionManager.forkFrom(branched, cwd, dir, { id });
    markInheritanceWindow(child);
    return child;
  } finally {
    if (branched) {
      try {
        unlinkSync(branched);
      } catch (error) {
        // The intermediate is inert (it is never listed as this store's record), so a failed
        // cleanup costs a stray file, not correctness — but silence would hide a full disk.
        log.warn(`[fastagent] could not remove the intermediate fork ${branched}: ${String(error)}`);
      }
    }
  }
}
