/**
 * A fork of a session (SPEC v1 §5), on pi's `SessionManager`: its path up to an entry, copied into a new record, and,
 * for `context: "recent"` (a chat thread starting from its room, participant-model.md §5), bounded to what the model
 * sees of it.
 */
import { type CompactionEntry, type SessionManager, estimateTokens } from "@earendil-works/pi-coding-agent";
import { log } from "../../log.ts";
import { isMessageMarker, isPlaneMarker } from "./session-markers.ts";

/** The recent window: at most this many exchanges of the source reach the copy's model context. */
const RECENT_MAX_EXCHANGES = 50;
/** …and at most roughly this many tokens (~1/4 of a 200K context: generous, not everything). */
const RECENT_MAX_TOKENS = 50_000;

/**
 * Bound what the child's MODEL CONTEXT starts with. Measured on pi's projection, what the model will actually see:
 * a `context_edit` omission (an abandoned retry or overflow attempt) costs nothing, and the harness's own `system`
 * entries are not history. The newest copied compaction (its summary, then the tail it retained) reaches the model
 * only while no window is cut: pi reads the NEWEST compaction alone, so a mark placed after it drops that tail. Its
 * summary, a few hundred tokens covering everything older, is carried into the mark instead.
 */
function markRecentWindow(child: SessionManager): void {
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
  const fits = (exchanges: number, tokens: number) => exchanges <= RECENT_MAX_EXCHANGES && tokens <= RECENT_MAX_TOKENS;
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
  // Typed by pi's own union, and exhaustive: a pi release that adds an entry type fails typecheck here instead of
  // being dropped from every copied branch without a word.
  for (const entry of parent.getBranch(at)) {
    let childId: string | undefined;
    switch (entry.type) {
      case "message":
        // Every message, INCLUDING the harness's system entries: the child starts from the prompt the parent was
        // running under, and pi diffs its own sections against it, so the thread's first request carries that
        // prompt once rather than twice.
        childId = child.appendMessage(entry.message as Parameters<SessionManager["appendMessage"]>[0]);
        break;
      case "custom_message":
        // Model-visible history, unlike the `custom` entries below it: an extension injected it INTO the
        // conversation, and the assistant messages answering it are being copied.
        childId = child.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
        break;
      case "compaction":
        // `firstKeptEntryId` is where the RETAINED TAIL starts — the entries pi did not summarize, which still reach
        // the model.
        childId = child.appendCompaction(
          entry.summary,
          copied.get(entry.firstKeptEntryId) ?? "",
          entry.tokensBefore,
          entry.details,
        );
        break;
      case "context_edit": {
        // pi omits an abandoned retry/overflow attempt from the model's context this way; dropping the edit would
        // hand that attempt back to the copy. Its target is a message, which the copy always anchors.
        const target = copied.get(entry.targetId);
        if (target) childId = child.appendContextEdit(target, entry.replacement);
        break;
      }
      case "model_change":
        childId = child.appendModelChange(entry.provider, entry.modelId);
        break;
      case "thinking_level_change":
        childId = child.appendThinkingLevelChange(entry.thinkingLevel);
        break;
      case "custom":
        // The plane's markers describe the parent's RECORD, and its message records its messages: neither is history.
        if (!isPlaneMarker(entry) && !isMessageMarker(entry))
          childId = child.appendCustomEntry(entry.customType, entry.data);
        break;
      case "label":
      case "session_info":
      case "branch_summary":
      case "usage":
        break; // the parent's facts, not the thread's history
      default: {
        // Unreachable by type; a record written by a newer pi can still carry one, and refusing to start the thread
        // over it would be worse than naming it.
        const unhandled: never = entry;
        log.warn(
          `[fastagent] a fork skipped a session entry of unknown type "${(unhandled as { type: string }).type}"`,
        );
      }
    }
    if (childId === undefined) unanchored.push(entry.id);
    else record(entry.id, childId);
  }
}

/** {@link copyBranchInto} plus the recent window: a fork with `context: "recent"`. */
export function copyRecentBranch(parent: SessionManager, child: SessionManager, at: string): void {
  copyBranchInto(parent, child, at);
  markRecentWindow(child);
}

// There is deliberately NO file-level fork here. pi can copy a path into a new file (`createBranchedSession` +
// `forkFrom`), but that pair writes the intermediate only when the copied path contains an ASSISTANT message — so
// forking at a user entry hands `forkFrom` a path that does not exist, and the failure reads as retryable for a
// condition no retry can change.
