/**
 * The agent's self-scheduled wake-ups — the SECOND producer of scheduled invocations (the first is the author's
 * `schedules/` files).
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
  /** When to fire next (ISO). */
  fireAt: string;
  /** RECURRING: the cron expression (5-field). */
  cron?: string;
  /** IANA timezone for `cron` (default UTC). */
  tz?: string;
  /** ONE-SHOT ONLY: consecutive busy-defer attempts. */
  attempts?: number;
}

/** The minimum delay a wake-up may be scheduled for — rejects a busy-loop (`wake in 1s`, then again…). */
export const MIN_WAKE_MS = 60_000; // 1 minute
/**
 * The cap on pending wake-ups PER SESSION — rejects one conversation's unbounded self-fan-out without letting it
 * starve others' quota (a global cap would make one chatty session a DoS on everyone else's `wake`, since a multi-user
 * deploy is one session per chat).
 */
export const MAX_PENDING_WAKEUPS = 20;
/** How many times a busy/transient wake is retried (deferred) before being dropped. */
export const MAX_WAKE_ATTEMPTS = 120;
/** The minimum gap between two consecutive fires of a RECURRING wake. */
const MIN_RECURRING_GAP_MS = 10 * 60_000; // 10 minutes

/** A stored entry is a real Wakeup: the fields are present and `fireAt` is a parseable date. */
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
    // A stored cron must PARSE: a bad one would throw inside the claim's nextRun.
    (w.cron === undefined ||
      (typeof w.cron === "string" && cronError(w.cron, typeof w.tz === "string" ? w.tz : undefined) === undefined))
  );
}

/** The wake-ALARM sink: notified after EVERY wakeups-store mutation. */
let wakeupsSink: ((stateRoot: string) => void) | undefined;
export function setWakeupsSink(sink: ((stateRoot: string) => void) | undefined): void {
  wakeupsSink = sink;
}

function load(stateRoot: string): Wakeup[] {
  const v = readScheduleFile(scheduleFile(stateRoot, "wakeups"));
  if (v === undefined) return []; // absent (first run) or a corrupt file readScheduleFile already warned on
  if (!Array.isArray(v)) {
    // Valid JSON but the wrong SHAPE (an object, say).
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
  try {
    wakeupsSink?.(stateRoot);
  } catch (e) {
    log.error(`[schedule] wake-alarm sink failed (store write is unaffected): ${String(e)}`);
  }
}

/** The current pending wake-ups (`fastagent schedule list` uses this). */
export function listWakeups(stateRoot: string): Wakeup[] {
  return load(stateRoot);
}

export type AddWakeupResult = { ok: true; id: string; fireAt: string } | { ok: false; error: string };

/** Add a wake-up — one-shot (`fireAt`) or recurring (`cron`/`tz`, `fireAt` = the first instant). */
export function addWakeup(
  stateRoot: string,
  input: { session: string; prompt: string; fireAt?: Date; cron?: string; tz?: string },
  now: Date = new Date(),
): AddWakeupResult {
  let fireAtDate: Date;
  if (input.cron !== undefined) {
    const err = cronError(input.cron, input.tz);
    if (err) return { ok: false, error: `invalid cron/tz: ${err}` };
    // A recurring wake runs FOREVER — gate its frequency harder than a one-shot: the gap between the next two
    // instants must be ≥ the recurring floor.
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
    // List what's pending WITH a prompt preview: "unwake one" is only actionable if the model has the ids AND can
    // choose by meaning.
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

export function removeWakeup(stateRoot: string, id: string, session?: string): boolean {
  const all = load(stateRoot);
  const kept = all.filter((w) => !(w.id === id && (session === undefined || w.session === session)));
  if (kept.length === all.length) return false;
  save(stateRoot, kept);
  return true;
}

/**
 * CLAIM the FIRST due wake-up (at or before `now`) in stored order, remove + return it, or undefined if none is due.
 */
export function takeFirstDueWakeup(stateRoot: string, now: Date = new Date()): Wakeup | undefined {
  const all = load(stateRoot);
  const idx = all.findIndex((w) => new Date(w.fireAt).getTime() <= now.getTime());
  if (idx === -1) return undefined;
  const w = all[idx] as Wakeup;
  if (w.cron !== undefined) {
    // RECURRING claim = ADVANCE IN PLACE: the entry STAYS in the store with fireAt pushed to the next cron instant
    // (attempts cleared).
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
 * Re-schedule a ONE-SHOT wake whose fire failed TRANSIENTLY (its session was busy — a channel is mid-turn on it),
 * deferred to `fireAt`.
 */
export function deferWakeup(stateRoot: string, w: Wakeup, fireAt: Date): boolean {
  const attempts = (w.attempts ?? 0) + 1;
  if (attempts > MAX_WAKE_ATTEMPTS) return false;
  save(stateRoot, [...load(stateRoot), { ...w, fireAt: fireAt.toISOString(), attempts }]);
  return true;
}
