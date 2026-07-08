/**
 * The agent's self-scheduled wake-ups — the SECOND producer of scheduled invocations (the first is the
 * author's `schedules/` files). The `wake` tool writes one here; the scheduler polls and fires it back
 * into the SAME session so the agent resumes the conversation it was in. Persisted
 * (`<stateRoot>/schedule/wakeups.json`) so a wake survives a restart. ONE-SHOT (`in`) or RECURRING
 * (`cron` — the entry keeps its id; each fire re-arms `fireAt` to the next cron instant).
 *
 * Guardrails (self-scheduling is a real runaway surface): a minimum one-shot delay (no busy-looping), a
 * minimum RECURRING gap (a high-frequency recurring burns tokens forever — stricter than one-shot), a
 * per-session pending cap (no fan-out, no cross-session quota DoS; a recurring occupies a slot for its
 * whole life), and the agent's `unwake` / the operator's `schedule cancel` as the kill switches.
 */
import { randomUUID } from "node:crypto";
import { log } from "../log.ts";
import { cronError, nextRun } from "./cron.ts";
import { readScheduleFile, scheduleFile, writeScheduleFile } from "./state.ts";

export interface Wakeup {
  id: string;
  /** The session to fire back into (the conversation the `wake` call ran in). */
  session: string;
  /** The instruction for the woken turn. */
  prompt: string;
  /** When to fire next (ISO). For a recurring wake this advances to the next cron instant on each fire. */
  fireAt: string;
  /** RECURRING: the cron expression (5-field). Absent = one-shot (fires once, removed). */
  cron?: string;
  /** IANA timezone for `cron` (default UTC). */
  tz?: string;
  /** ONE-SHOT ONLY: consecutive busy-defer attempts. A one-shot into a BUSY session (`code: session_busy`
   *  — the turn never started) is deferred, bounded by {@link MAX_WAKE_ATTEMPTS}, then dropped. A RECURRING
   *  occurrence never defers (this field never increments for it): a busy one is skipped on FIRST contact
   *  — its claim already advanced the entry, and the next occurrence comes by definition. */
  attempts?: number;
}

/** The minimum delay a wake-up may be scheduled for — rejects a busy-loop (`wake in 1s`, then again…). */
export const MIN_WAKE_MS = 60_000; // 1 minute
/** The cap on pending wake-ups PER SESSION — rejects one conversation's unbounded self-fan-out without
 *  letting it starve others' quota (a global cap would make one chatty session a DoS on everyone else's
 *  `wake`, since a multi-user deploy is one session per chat). */
export const MAX_PENDING_WAKEUPS = 20;
/** How many times a busy/transient wake is retried (deferred) before being dropped. At the ~30s poll a
 *  wake into an active conversation fires in the first gap between the user's turns; this generous
 *  ceiling (~1h) only gives up on a pathologically stuck session (then logs, operator-visible). */
export const MAX_WAKE_ATTEMPTS = 120;
/** The minimum gap between two consecutive fires of a RECURRING wake — stricter than the one-shot floor:
 *  a recurring runs forever, so a tight cron is a permanent token burner, not a one-time mistake. */
export const MIN_RECURRING_GAP_MS = 10 * 60_000; // 10 minutes

/** A stored entry is a real Wakeup: the fields are present and `fireAt` is a parseable date. A malformed
 *  one (bad/missing fireAt) would compare NaN <= now = false forever — never due, never cleared, but still
 *  eating the pending quota. So validate at this IO boundary and drop it (warn), like a corrupt file. */
function isWakeup(e: unknown): e is Wakeup {
  if (!e || typeof e !== "object") return false;
  const w = e as Record<string, unknown>;
  return (
    typeof w.id === "string" &&
    typeof w.session === "string" &&
    typeof w.prompt === "string" &&
    typeof w.fireAt === "string" &&
    !Number.isNaN(Date.parse(w.fireAt)) &&
    (w.attempts === undefined || typeof w.attempts === "number") && // a non-number would make deferWakeup's count NaN
    (w.tz === undefined || typeof w.tz === "string") &&
    // A stored cron must PARSE: a bad one would throw inside the claim's nextRun — before the advance-save
    // — so its fireAt never moves, it stays first-due forever, and every wakeup behind it starves (a poison
    // pill worse than the bad-fireAt zombie this validator already guards).
    (w.cron === undefined ||
      (typeof w.cron === "string" && cronError(w.cron, typeof w.tz === "string" ? w.tz : undefined) === undefined))
  );
}

function load(stateRoot: string): Wakeup[] {
  const v = readScheduleFile(scheduleFile(stateRoot, "wakeups"));
  if (v === undefined) return []; // absent (first run) or a corrupt file readScheduleFile already warned on
  if (!Array.isArray(v)) {
    // Valid JSON but the wrong SHAPE (an object, say) — fail-visible, don't silently drop the whole store
    // (a per-entry malformed drop already warns; a whole-store shape error must too).
    log.warn(`[schedule] wakeups store is not an array — ignoring it: ${JSON.stringify(v).slice(0, 80)}`);
    return [];
  }
  const valid: Wakeup[] = [];
  for (const e of v) {
    if (isWakeup(e)) valid.push(e);
    else log.warn(`[schedule] dropping a malformed wake-up entry: ${JSON.stringify(e)}`);
  }
  return valid;
}
function save(stateRoot: string, wakeups: Wakeup[]): void {
  writeScheduleFile(scheduleFile(stateRoot, "wakeups"), wakeups);
}

/** The current pending wake-ups (tests today; a `schedule` inspection command is Phase 2). */
export function listWakeups(stateRoot: string): Wakeup[] {
  return load(stateRoot);
}

export type AddWakeupResult = { ok: true; id: string; fireAt: string } | { ok: false; error: string };

/**
 * Add a wake-up — one-shot (`fireAt`) or recurring (`cron`/`tz`, `fireAt` = the first instant) —
 * enforcing the guardrails (min delay / min recurring gap, per-session pending cap). Returns a
 * MODEL-facing error string on rejection (the `wake` tool passes it back so the model can adjust),
 * never throws for a bad request.
 */
export function addWakeup(
  stateRoot: string,
  input: { session: string; prompt: string; fireAt?: Date; cron?: string; tz?: string },
  now: Date = new Date(),
): AddWakeupResult {
  let fireAtDate: Date;
  if (input.cron !== undefined) {
    const err = cronError(input.cron, input.tz);
    if (err) return { ok: false, error: `invalid cron/tz: ${err}` };
    // A recurring wake runs FOREVER — gate its frequency harder than a one-shot: the gap between the next
    // two instants must be ≥ the recurring floor. (First-pair heuristic; an irregular cron with one tight
    // pair can slip through — an accepted ceiling, the per-session cap still bounds total load.)
    const first = nextRun(input.cron, input.tz, now);
    const second = first && nextRun(input.cron, input.tz, first);
    if (!first || !second)
      return { ok: false, error: "this cron never fires (or fires only once) — use `in` for a one-shot." };
    if (second.getTime() - first.getTime() < MIN_RECURRING_GAP_MS) {
      return {
        ok: false,
        error: `too frequent — a recurring wake must fire at most every ${MIN_RECURRING_GAP_MS / 60_000} minutes.`,
      };
    }
    fireAtDate = first; // DERIVED from the cron — a caller-passed fireAt can't disagree with the schedule
  } else {
    if (!input.fireAt) return { ok: false, error: "a one-shot wake needs its fire time (`in`)." };
    if (input.fireAt.getTime() < now.getTime() + MIN_WAKE_MS) {
      return { ok: false, error: `too soon — the minimum wake delay is ${MIN_WAKE_MS / 1000}s.` };
    }
    fireAtDate = input.fireAt;
  }
  const all = load(stateRoot);
  const mine = all.filter((w) => w.session === input.session);
  if (mine.length >= MAX_PENDING_WAKEUPS) {
    // List what's pending WITH a prompt preview: "unwake one" is only actionable if the model has the
    // ids AND can choose by meaning — both were returned when set, but that may be buried far back in
    // the conversation.
    const pending = mine
      .map(
        (w) =>
          `${w.id}${w.cron ? ` (recurring "${w.cron}")` : ""} at ${w.fireAt}: ${
            w.prompt.length > 60 ? `${w.prompt.slice(0, 60)}…` : w.prompt
          }`,
      )
      .join("; ");
    return {
      ok: false,
      error: `too many pending wake-ups for this conversation (${MAX_PENDING_WAKEUPS}) — wait for some to fire, or unwake one. Pending: ${pending}`,
    };
  }
  const id = randomUUID();
  const fireAt = fireAtDate.toISOString();
  save(stateRoot, [
    ...all,
    { id, session: input.session, prompt: input.prompt, fireAt, cron: input.cron, tz: input.tz },
  ]);
  return { ok: true, id, fireAt };
}

/**
 * Remove a wake-up by id. `session` (when given — the agent's `unwake`) must ALSO match, so a
 * conversation can only cancel its OWN wake-ups; the operator's `schedule cancel` passes none.
 * Returns whether anything was removed.
 */
export function removeWakeup(stateRoot: string, id: string, session?: string): boolean {
  const all = load(stateRoot);
  const kept = all.filter((w) => !(w.id === id && (session === undefined || w.session === session)));
  if (kept.length === all.length) return false;
  save(stateRoot, kept);
  return true;
}

/**
 * CLAIM the FIRST due wake-up (at or before `now`) in stored order, remove + return it, or undefined if
 * none is due. Stored order, not earliest-`fireAt`: the caller drains them all in one poll, so order among
 * due entries doesn't matter. One at a time on purpose — the caller fires it before claiming the next, so a
 * crash loses AT MOST one wake-up (claiming a whole due batch up front would lose the lot). Claim-before-fire
 * = a turn EXECUTES at most once per claim; a wake that couldn't start (busy session) is re-claimed via
 * {@link deferWakeup}.
 */
export function takeFirstDueWakeup(stateRoot: string, now: Date = new Date()): Wakeup | undefined {
  const all = load(stateRoot);
  const idx = all.findIndex((w) => new Date(w.fireAt).getTime() <= now.getTime());
  if (idx === -1) return undefined;
  const w = all[idx] as Wakeup;
  if (w.cron !== undefined) {
    // RECURRING claim = ADVANCE IN PLACE: the entry STAYS in the store with fireAt pushed to the next cron
    // instant (attempts cleared). So (a) `unwake`/`schedule cancel` work at ANY moment — including inside
    // the woken turn itself, the documented way to stop a done recurring job (a remove+re-add claim would
    // resurrect what that turn just cancelled); and (b) a crash mid-fire loses at most ONE occurrence,
    // never the recurrence — matching the static cron schedules' claim semantics.
    const next = nextRun(w.cron, w.tz, now);
    if (next) all[idx] = { ...w, fireAt: next.toISOString(), attempts: undefined };
    else all.splice(idx, 1); // the cron has no next instant — this is its final occurrence
    save(stateRoot, all);
    return { ...w }; // THIS occurrence (original fireAt); the store already holds the next
  }
  all.splice(idx, 1);
  save(stateRoot, all);
  return w;
}

/**
 * Re-schedule a ONE-SHOT wake whose fire failed TRANSIENTLY (its session was busy — a channel is mid-turn
 * on it), deferred to `fireAt`. Returns false (dropped, NOT re-added) once attempts exceed
 * {@link MAX_WAKE_ATTEMPTS} — a one-shot has no "next time", so a busy-skip that just dropped it would lose
 * it forever; bounded retries, then give up visibly. A RECURRING occurrence is never deferred: its claim
 * already advanced the entry, and its next occurrence comes by definition — a busy one is skipped + audited.
 *
 * Known residual: between the claim (removed from the store) and this re-add there is a microtask-scale
 * window (the busy reject yields before any harness IO) where an `unwake` for this id reports "not found"
 * and the defer then resurrects it — the one-shot cousin of the recurring resurrection the advance-in-place
 * claim eliminated. Accepted: closing it needs a claim-lease with expiry, disproportionate to the window.
 */
export function deferWakeup(stateRoot: string, w: Wakeup, fireAt: Date): boolean {
  const attempts = (w.attempts ?? 0) + 1;
  if (attempts > MAX_WAKE_ATTEMPTS) return false;
  save(stateRoot, [...load(stateRoot), { ...w, fireAt: fireAt.toISOString(), attempts }]);
  return true;
}
