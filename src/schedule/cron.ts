/** The one place that touches the cron library (`croner`). */
import { Cron } from "croner";

/**
 * The next scheduled instant STRICTLY AFTER `from` (in `tz`, default UTC), or undefined if the expression will never
 * fire again.
 */
export function nextRun(cron: string, tz: string | undefined, from: Date): Date | undefined {
  return new Cron(cron, { timezone: tz ?? "UTC" }).nextRun(from) ?? undefined;
}

/**
 * The most recent scheduled instant AT OR BEFORE `from`, or undefined if the expression has never fired by then.
 *
 * What lets an external clock omit the slot: the caller's wall clock is a few hundred milliseconds off the cron
 * instant, and a slot is an IDENTITY (`claimSlot` keys on it), so sending `now` would mint a different name on every
 * retry and fire the same occurrence twice. Snapping here puts the caller on the same grid the resident loop uses,
 * without asking a crontab line to compute it.
 */
export function previousRun(cron: string, tz: string | undefined, from: Date): Date | undefined {
  const job = new Cron(cron, { timezone: tz ?? "UTC" });
  // FLOORED TO THE SECOND FIRST, and that is the whole correctness of this function. croner steps backwards by
  // zeroing the milliseconds and then subtracting a whole second, so any reference inside the second an occurrence
  // began — `10:00:00.300` for a `0 * * * *` — walks past it to the previous one. That is precisely where a crontab
  // lands: cron wakes at the instant, the process starts, the request arrives some hundreds of milliseconds later.
  // The second an occurrence began IS that occurrence, so the caller is placed in it rather than one before.
  const floored = new Date(Math.floor(from.getTime() / 1000) * 1000);
  // `previousRuns` is exclusive of its reference, and a caller landing exactly ON an instant means THAT occurrence —
  // the ordinary case for an external clock that computed the same grid we did.
  const exact = job.nextRun(new Date(floored.getTime() - 1));
  if (exact !== null && exact.getTime() === floored.getTime()) return floored;
  return job.previousRuns(1, floored)[0];
}

/**
 * Why `cron`/`tz` is invalid (for load-time validation), or undefined if valid. croner validates the timezone lazily
 * (not at construction), so check it explicitly via Intl (throws on an unknown IANA zone); the pattern is validated by
 * constructing the Cron.
 */
export function cronError(cron: string, tz: string | undefined): string | undefined {
  if (tz !== undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
    } catch {
      return `unknown timezone "${tz}"`;
    }
  }
  try {
    new Cron(cron, { timezone: tz ?? "UTC" });
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}
