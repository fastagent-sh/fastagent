/**
 * Durable turn intent: the L1 half of durable execution (the L2 exactly-once / deterministic
 * step-replay layer is the K-axis backend — docs/design/core.md §11). Persists an accepted turn BEFORE
 * the webhook 200 (pre-ACK, like context-buffer) and removes it when the turn ENDS — the runner's
 * `finally`: a completed turn OR any caught error both remove it. Precisely, a completed turn's removal
 * fires at the `completed` event (the session is committed), which is BEFORE streamReply delivers the
 * answer to Telegram: so L1 recovers the ACKed-but-un-COMPLETED window, not un-DELIVERED. A crash in
 * that narrow tail (completed, session-committed, but the message not yet sent) leaves the answer in the
 * session history undelivered and is deliberately NOT replayed — replaying a session-committed turn
 * would double-append it; the asker re-asks (and sees the prior answer in history). L1's scope is the
 * INTERRUPTED-run window (the `finally` never runs); a caught error is NOT retried here — a `failed`
 * event already told the user, and a transport throw is dropped exactly like the pre-L1 in-memory queue
 * did (replaying it could double-send). Only an interrupted run leaves the record on disk — and
 * "interrupted" is not just a rare crash: `runStart` has no graceful drain (cli.ts), so a SIGTERM exits
 * mid-turn too, i.e. EVERY rolling deploy that catches an in-flight turn. Recovery re-enqueues it next start.
 *
 * This recovers the ACKed-but-unfinished window the in-memory turn-queue drops (turn-queue.ts). Weigh
 * the trade before trusting it: the alternative (dropping the turn) fails VISIBLY and self-corrects
 * (the turn vanished, the asker re-asks); replay's sharpest cost is the opposite — invisible. It is
 * at-least-once, not exactly-once:
 *   - PRIMARY cost: replay re-runs the WHOLE turn, so every external side effect happens AGAIN — re-sent
 *     messages, re-fired tool actions — and nobody may notice (unlike the visible loss it replaces).
 *     And the trigger is not rare (above): it fires on every deploy that interrupts an in-flight turn,
 *     not just on crashes. So "safe only if the turn's tools are idempotent" is a bar to judge against
 *     DEPLOY frequency: it holds for a Q&A bot, and is the gate for adding side-effecting tools. (A
 *     mid-stream interruption also leaves an orphan "💭 Thinking…" preview — cosmetic.)
 *   - The pre-ACK window overlaps Telegram redelivery: a crash AFTER the persist but BEFORE the 200
 *     means recovery replays the turn AND Telegram (never-ACKed) redelivers the same update — same
 *     update_id, but the queue does not dedup, so the turn can run twice. Exactly-once (a persisted
 *     delivery key) is L2.
 *
 * ponytail: at-least-once with a per-turn EXECUTION ceiling. A poison turn that deterministically
 * crashes the process would replay forever under a container restart policy. The counter is bumped at
 * `startAttempt` — when a turn is about to RUN, not per restart cycle — so it counts a turn's OWN
 * execution attempts: `recover()` re-enqueues every surviving turn without touching its count, and a
 * poison turn at a session's head is dropped on its own N+1th run WITHOUT penalizing the never-run turns
 * queued behind it (they keep their full budget and get their turn once the poison one is gone). On drop,
 * the runner notifies the asker (the chain's end must get a signal — a log line the user can't see isn't).
 * The bump is the ONE post-ACK write that fails CLOSED (not best-effort): if it can't be persisted the
 * turn is DEFERRED — skipped this cycle and left on disk to replay on the next start — rather than run
 * untracked, because an unpersisted count lets recover() re-run a poison turn every restart (the ceiling
 * would never advance on disk). It replays on the next START — a restart is required; disk recovery alone
 * does not re-run a deferred turn — and the asker is NOT told (a transient system degrade, not a user-
 * actionable failure — telling them "ask again" would double-answer on that replay).
 * Single-process, single-writer: same durability model as state.ts (crash-safe via atomic rename;
 * power-loss is best-effort — no fsync, consistent with the rest of the channel's state).
 */
import { log } from "../../log.ts";
import { loadStateFile, saveStateFile } from "./state.ts";

/** An accepted turn's persisted intent — the SOURCE for the fields a runner needs to re-execute it
 *  (telegram.ts's PendingTurn derives from this, so a new execution field added here propagates and
 *  cannot silently drop from the persisted record). Minus the live `previewId` (a restart's queue
 *  notice is gone; a replayed turn sends a fresh preview). `attempts` counts how many times this turn
 *  has STARTED executing without finishing (0 until its first run; bumped at each `startAttempt`). */
export interface StoredTurn {
  id: string;
  session: string;
  placeKey: string;
  baseText: string;
  chatId: number | string;
  threadId?: number;
  replyTo?: number;
  imageFileIds: string[];
  fileIds: string[];
  attempts: number;
}

export interface TurnStore {
  /** Persist an accepted turn before the ACK. A failed write throws (→ webhook 500, Telegram redelivers). */
  add(rec: StoredTurn): void;
  /** Remove a finished turn. Post-ACK: a failed write is logged, never thrown (must not abort delivery). */
  remove(id: string): void;
  /** Every persisted turn a crash left behind, in ARRIVAL order, to re-enqueue on the next start. Read-
   *  only — the ceiling is enforced per turn at `startAttempt`, so a never-run turn's budget is untouched
   *  by a restart. Order matters: the queue rebuilds each session's FIFO chain from re-enqueue order. */
  recover(): StoredTurn[];
  /** Called when a turn is about to RUN (dequeued). Returns:
   *   - "run": bumped its persisted execution count; go ahead.
   *   - "exceeded": over `maxAttempts` starts without finishing (killed mid-run every time, whatever the
   *     cause); the record is dropped and the runner notifies the asker.
   *   - "defer": the bump could not be persisted — skip this cycle (fail closed: an unpersisted count
   *     would let a poison turn re-run forever); the record stays on disk and replays on the next start
   *     (a restart is required — disk recovery alone does not re-run it). The runner does NOT notify.
   *  An id with no record returns "run" (untracked): a completed turn's `remove` cleared it, so the
   *  redelivery-double-run tail (see the header's pre-ACK window) lands here. */
  startAttempt(id: string, maxAttempts: number): "run" | "exceeded" | "defer";
}

/** State files are an IO boundary: valid JSON of the WRONG SHAPE must degrade like a corrupt file
 *  (warn + empty), not flow in as trusted data (mirrors context-buffer's isBufferEntry). */
function isStoredTurn(t: unknown): t is StoredTurn {
  const r = t as StoredTurn;
  const strings = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === "string");
  return (
    typeof r?.id === "string" &&
    typeof r.session === "string" &&
    typeof r.placeKey === "string" &&
    typeof r.baseText === "string" &&
    (typeof r.chatId === "string" || typeof r.chatId === "number") &&
    (r.threadId === undefined || typeof r.threadId === "number") &&
    (r.replyTo === undefined || typeof r.replyTo === "number") &&
    strings(r.imageFileIds) &&
    strings(r.fileIds) &&
    typeof r.attempts === "number"
  );
}

export function createTurnStore(path: string): TurnStore {
  const load = (): Map<string, StoredTurn> => {
    const raw = loadStateFile(path);
    if (raw === undefined) return new Map();
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw) && Object.values(raw).every(isStoredTurn)) {
      return new Map(Object.entries(raw as Record<string, StoredTurn>));
    }
    log.warn(`[telegram] unexpected shape in ${path} — starting with no pending turns`);
    return new Map();
  };
  const turns = load();
  const persist = (): void => saveStateFile(path, Object.fromEntries(turns));
  // Post-ACK writes (remove, startAttempt) must not abort a turn: log a failed write, never throw.
  const persistBestEffort = (what: string): void => {
    try {
      persist();
    } catch (e) {
      log.error(`[telegram] turn-store ${what} write failed post-ACK: ${String(e)}`);
    }
  };

  return {
    add(rec) {
      // Idempotent on re-add: a redelivery (pre-ACK crash → never-ACKed update replayed) re-submits an id
      // already in the store. Skip it — the intent is already durable, and overwriting would RESET this
      // turn's execution count, handing a poison turn a fresh ceiling budget.
      if (turns.has(rec.id)) return;
      turns.set(rec.id, rec);
      try {
        persist(); // pre-ACK: a throw becomes the webhook's 500 and Telegram redelivers
      } catch (e) {
        // Roll the memory back so it matches disk (mirrors context-buffer.push): otherwise the phantom
        // entry makes the redelivery's `add` short-circuit on `turns.has` — running the turn with its
        // intent never persisted, defeating this module — and gets flushed later by an unrelated persist.
        turns.delete(rec.id);
        throw e;
      }
    },
    remove(id) {
      if (turns.delete(id)) persistBestEffort("remove (a restart may replay an answered turn)");
    },
    recover() {
      // Arrival order, so the queue rebuilds each session's FIFO chain correctly. Ids are Telegram
      // update_ids — monotonic — so numeric id order IS arrival order; sort on it explicitly rather than
      // lean on JS object-key enumeration happening to survive the load's JSON round-trip.
      return [...turns.values()].sort((a, b) => Number(a.id) - Number(b.id));
    },
    startAttempt(id, maxAttempts) {
      const rec = turns.get(id);
      if (!rec) return "run"; // no record — run untracked (a redelivery double-run whose first run removed it)
      const attempts = rec.attempts + 1;
      if (attempts > maxAttempts) {
        // State the fact, not a cause the counter can't prove: a turn killed mid-run every time bumps
        // this whether IT poisoned the process or a deploy/OOM took it down each time.
        log.error(
          `[telegram] dropping turn ${id} after starting ${rec.attempts} time(s) without finishing ` +
            `(session=${rec.session}) — it may be crashing the process, or was killed mid-run each time; notifying the asker`,
        );
        turns.delete(id);
        persistBestEffort("drop");
        return "exceeded";
      }
      turns.set(id, { ...rec, attempts });
      try {
        persist();
      } catch (e) {
        // The bump MUST be durable, unlike remove/drop: if it isn't, a restart's recover() reads the old
        // count and RE-RUNS this turn — a poison turn would re-execute forever (the ceiling never advances
        // on disk). Fail closed: roll the memory bump back (match disk) and DEFER — the record stays on
        // disk with its old count and replays on the next start (a restart is required; disk recovery
        // alone won't re-run it). Not a drop: under disk failure the removal couldn't persist anyway.
        // The runner skips silently (no notify).
        turns.set(id, rec);
        log.error(
          `[telegram] cannot persist turn ${id}'s attempt count — deferring it to the next start rather ` +
            `than run it untracked (session=${rec.session}): ${String(e)}`,
        );
        return "defer";
      }
      return "run";
    },
  };
}
