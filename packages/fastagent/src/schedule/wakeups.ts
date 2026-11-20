/**
 * The agent's self-scheduled wake-ups — the SECOND producer of scheduled invocations (the first is the author's
 * `schedules/` files) — kept in the clock's store (clock.ts).
 */
import { randomUUID } from "node:crypto";
import { log } from "../log.ts";
import { cronError, nextRun, recurringCronError } from "./cron.ts";
import type { ClockStore } from "./clock.ts";

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
}

/**
 * Parse a delay to milliseconds: a number is SECONDS; a string MUST carry a unit — `"<n><s|m|h|d>"` ("30m", "2h",
 * "1d").
 */
export function parseDelayMs(input: string | number): number | undefined {
  if (typeof input === "number") return Number.isFinite(input) && input > 0 ? input * 1000 : undefined;
  const m = input.trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i); // unit REQUIRED on a string
  if (!m) return undefined;
  const mult = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[(m[2] as string).toLowerCase() as "s"];
  return Number(m[1]) * mult;
}

/** The minimum delay a wake-up may be scheduled for — rejects a busy-loop (`wake in 1s`, then again…). */
const MIN_WAKE_MS = 60_000; // 1 minute
/**
 * The cap on pending wake-ups PER SESSION — rejects one conversation's unbounded self-fan-out without letting it
 * starve others' quota (a global cap would make one chatty session a DoS on everyone else's `wake`, since a multi-user
 * deploy is one session per chat).
 */
export const MAX_PENDING_WAKEUPS = 20;

/** A stored entry is a real Wakeup: the fields are present, `fireAt` is a date, and a cron still parses. */
function isWakeup(e: unknown): e is Wakeup {
  if (!e || typeof e !== "object") return false;
  const w = e as Record<string, unknown>;
  return (
    typeof w.id === "string" &&
    typeof w.session === "string" &&
    typeof w.prompt === "string" &&
    typeof w.fireAt === "string" &&
    !Number.isNaN(Date.parse(w.fireAt)) &&
    (w.tz === undefined || typeof w.tz === "string") &&
    // A stored cron must PARSE: a bad one would throw inside the claim's nextRun.
    (w.cron === undefined ||
      (typeof w.cron === "string" && cronError(w.cron, typeof w.tz === "string" ? w.tz : undefined) === undefined))
  );
}

/** The stored wake-ups that are wake-ups: one a later version cannot read is dropped, and said. */
function valid(stored: readonly Wakeup[]): Wakeup[] {
  return stored.filter((e) => {
    if (isWakeup(e)) return true;
    log.warn(`[schedule] dropping a malformed wake-up entry: ${JSON.stringify(e)}`);
    return false;
  });
}

/** A wake-up as stored: no field without a value. */
const stored = (w: Wakeup): Wakeup => ({
  id: w.id,
  session: w.session,
  prompt: w.prompt,
  fireAt: w.fireAt,
  ...(w.cron === undefined ? {} : { cron: w.cron }),
  ...(w.tz === undefined ? {} : { tz: w.tz }),
});

/** The current pending wake-ups. */
export async function listWakeups(clock: ClockStore): Promise<Wakeup[]> {
  return valid(await clock.stored.wakeups());
}

export type AddWakeupResult = { ok: true; id: string; fireAt: string } | { ok: false; error: string };

/** Add a wake-up — one-shot (`fireAt`) or recurring (`cron`/`tz`, `fireAt` = the first instant). */
export async function addWakeup(
  clock: ClockStore,
  input: { session: string; prompt: string; fireAt?: Date; cron?: string; tz?: string },
  now: Date = new Date(),
): Promise<AddWakeupResult> {
  let fireAtDate: Date;
  if (input.cron !== undefined) {
    // A recurring wake runs FOREVER — gated harder than a one-shot, by the rule every recurring producer shares.
    const err = recurringCronError(input.cron, input.tz);
    if (err)
      return { ok: false, error: `${err}${err.startsWith("this cron never") ? " — use `in` for a one-shot" : ""}.` };
    // DERIVED from the cron — a caller-passed fireAt can't disagree with the schedule.
    const first = nextRun(input.cron, input.tz, now);
    if (!first) return { ok: false, error: "this cron never fires again — use `in` for a one-shot." };
    fireAtDate = first;
  } else {
    if (!input.fireAt) return { ok: false, error: "a one-shot wake needs its fire time (`in`)." };
    if (input.fireAt.getTime() < now.getTime() + MIN_WAKE_MS) {
      return { ok: false, error: `too soon — the minimum wake delay is ${MIN_WAKE_MS / 1000}s.` };
    }
    fireAtDate = input.fireAt;
  }
  return clock.wakeups((current): { next?: readonly Wakeup[]; result: AddWakeupResult } => {
    const all = valid(current);
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
        result: {
          ok: false,
          error: `too many pending wake-ups for this conversation (${MAX_PENDING_WAKEUPS}) — wait for some to fire, or unwake one. Pending: ${pending}`,
        },
      };
    }
    const id = randomUUID();
    const fireAt = fireAtDate.toISOString();
    const added = stored({ id, session: input.session, prompt: input.prompt, fireAt, cron: input.cron, tz: input.tz });
    return { next: [...all, added], result: { ok: true, id, fireAt } };
  });
}

/**
 * Remove ONE pending wake-up, and only from the session that made it: `unwake`, an agent cancelling its own alarm.
 * Cancelling another conversation's silently is a cost with no matching benefit.
 */
export async function removeWakeup(clock: ClockStore, id: string, session: string): Promise<boolean> {
  return (await removeWhere(clock, (w) => w.id === id && w.session === session)) !== undefined;
}

/**
 * Remove ONE pending wake-up whatever session set it: the operator's (`wakeups.cancel`), the one way out of a
 * wake-up set in a session nobody can message (a schedule's own).
 */
export function removeAnyWakeup(clock: ClockStore, id: string): Promise<Wakeup | undefined> {
  return removeWhere(clock, (w) => w.id === id);
}

/** Remove every pending wake-up belonging to `session` (e.g. when the session is deleted). */
export async function removeSessionWakeups(clock: ClockStore, session: string): Promise<number> {
  if (!(await clock.stored.wakeups()).some((w) => w.session === session)) return 0;
  return clock.wakeups((current) => {
    const all = valid(current);
    const kept = all.filter((w) => w.session !== session);
    const removed = all.length - kept.length;
    return removed === 0 ? { result: 0 } : { next: kept, result: removed };
  });
}

async function removeWhere(clock: ClockStore, match: (w: Wakeup) => boolean): Promise<Wakeup | undefined> {
  // Nothing to remove is answered from what is stored, committing nothing.
  if (!(await clock.stored.wakeups()).some(match)) return undefined;
  return clock.wakeups((current) => {
    const all = valid(current);
    const index = all.findIndex(match);
    if (index === -1) return { result: undefined };
    const [removed] = all.splice(index, 1);
    return { next: all, result: removed };
  });
}

/**
 * CLAIM the FIRST due wake-up (at or before `now`) in stored order, remove + return it, or undefined if none is due.
 */
export async function takeFirstDueWakeup(clock: ClockStore, now: Date = new Date()): Promise<Wakeup | undefined> {
  const due = (w: Wakeup) => new Date(w.fireAt).getTime() <= now.getTime();
  // Every poll asks; a poll with nothing due commits nothing.
  if (!(await clock.stored.wakeups()).some(due)) return undefined;
  return clock.wakeups((current) => {
    const all = valid(current);
    const idx = all.findIndex(due);
    if (idx === -1) return { result: undefined };
    const w = all[idx] as Wakeup;
    if (w.cron !== undefined) {
      // RECURRING claim = ADVANCE IN PLACE: the entry STAYS with fireAt pushed to the next cron instant.
      const next = nextRun(w.cron, w.tz, now);
      if (next) all[idx] = { ...w, fireAt: next.toISOString() };
      else all.splice(idx, 1); // the cron has no next instant — this is its final occurrence
      return { next: all, result: { ...w } }; // THIS occurrence (original fireAt); the store holds the next
    }
    all.splice(idx, 1);
    return { next: all, result: w };
  });
}

/**
 * Put back a ONE-SHOT wake-up its session refused for now (the process or the session's queue was full), to fire at
 * `fireAt`. It was taken out of the store to fire, so it does not count against the session's cap again.
 */
export async function requeueWakeup(clock: ClockStore, w: Wakeup, fireAt: Date): Promise<void> {
  await clock.wakeups((current) => ({
    next: [...valid(current), stored({ ...w, fireAt: fireAt.toISOString() })],
    result: undefined,
  }));
}
