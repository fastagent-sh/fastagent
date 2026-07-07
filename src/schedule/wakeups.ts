/**
 * The agent's self-scheduled one-shot wake-ups (Phase 4a) — the SECOND producer of scheduled
 * invocations (the first is the author's `schedules/` files). The `wake` tool writes one here; the
 * scheduler polls and fires it back into the SAME session so the agent resumes the conversation it was
 * in. Persisted (`<stateRoot>/schedule/wakeups.json`) so a wake survives a restart.
 *
 * Guardrails (self-scheduling is a real runaway surface): a minimum delay (no busy-looping) and a cap
 * on pending wake-ups (no unbounded fan-out). A one-shot wake is naturally bounded — it fires once and
 * is removed — so recurring self-scheduling (with heavier guardrails) is deliberately a later phase.
 */
import { randomUUID } from "node:crypto";
import { log } from "../log.ts";
import { readScheduleFile, scheduleFile, writeScheduleFile } from "./state.ts";

export interface Wakeup {
  id: string;
  /** The session to fire back into (the conversation the `wake` call ran in). */
  session: string;
  /** The instruction for the woken turn. */
  prompt: string;
  /** When to fire (ISO). */
  fireAt: string;
  /** Re-fire attempts so far. A wake into a BUSY session (a channel mid-turn on the same id) fails with
   *  `code: session_busy` — the turn never started, so it is deferred (only that case; a failure whose turn
   *  DID run is terminal); after the cap it is dropped rather than retried forever. */
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
 *  ceiling (~1h) only gives up on a pathologically stuck session (then logs, operator-visible — an
 *  in-conversation "couldn't resume" notice is Phase 4b). */
export const MAX_WAKE_ATTEMPTS = 120;

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
    (w.attempts === undefined || typeof w.attempts === "number") // a non-number would make deferWakeup's count NaN
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
 * Add a wake-up, enforcing the guardrails (min delay, pending cap). Returns a MODEL-facing error string
 * on rejection (the `wake` tool passes it back so the model can adjust), never throws for a bad request.
 */
export function addWakeup(
  stateRoot: string,
  input: { session: string; prompt: string; fireAt: Date },
  now: Date = new Date(),
): AddWakeupResult {
  if (input.fireAt.getTime() < now.getTime() + MIN_WAKE_MS) {
    return { ok: false, error: `too soon — the minimum wake delay is ${MIN_WAKE_MS / 1000}s.` };
  }
  const all = load(stateRoot);
  if (all.filter((w) => w.session === input.session).length >= MAX_PENDING_WAKEUPS) {
    return {
      ok: false,
      error: `too many pending wake-ups for this conversation (${MAX_PENDING_WAKEUPS}) — wait for some to fire before adding more.`,
    };
  }
  const id = randomUUID();
  const fireAt = input.fireAt.toISOString();
  save(stateRoot, [...all, { id, session: input.session, prompt: input.prompt, fireAt }]);
  return { ok: true, id, fireAt };
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
  const [w] = all.splice(idx, 1);
  save(stateRoot, all);
  return w;
}

/**
 * Re-schedule a wake whose fire failed TRANSIENTLY (its session was busy — a channel is mid-turn on it),
 * deferred to `fireAt`. Returns false (dropped, NOT re-added) once attempts exceed {@link MAX_WAKE_ATTEMPTS}
 * — a wake is one-shot, so a busy-skip that just dropped it would lose it forever (the failure mode a cron
 * slot does not have); this retries it a bounded number of times, then gives up visibly.
 */
export function deferWakeup(stateRoot: string, w: Wakeup, fireAt: Date): boolean {
  const attempts = (w.attempts ?? 0) + 1;
  if (attempts > MAX_WAKE_ATTEMPTS) return false;
  save(stateRoot, [...load(stateRoot), { ...w, fireAt: fireAt.toISOString(), attempts }]);
  return true;
}
