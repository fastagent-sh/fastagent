/** The one place that touches the cron library (`croner`). */
import { Cron } from "croner";

/**
 * The next scheduled instant STRICTLY AFTER `from` (in `tz`, default UTC), or undefined if the expression will never
 * fire again.
 */
export function nextRun(cron: string, tz: string | undefined, from: Date): Date | undefined {
  return new Cron(cron, { timezone: tz ?? "UTC" }).nextRun(from) ?? undefined;
}

/** How far back {@link previousRun} looks. A leap-day cron is four years apart; a 7-field one can name a year. */
const MAX_LOOKBACK_MS = 100 * 365.25 * 24 * 60 * 60 * 1000;

/**
 * The most recent scheduled instant AT OR BEFORE `from`, or undefined if the expression has not fired by then.
 *
 * What lets an external clock omit the slot: the caller's wall clock is a few hundred milliseconds off the cron
 * instant, and a slot is an IDENTITY (`claimSlot` keys on it), so sending `now` would mint a different name on every
 * retry and fire the same occurrence twice. Snapping here puts the caller on the same grid the resident loop uses,
 * without asking a crontab line to compute it.
 *
 * BUILT ON `nextRun` ALONE, by binary search, rather than on croner's own backward stepper. `previousRuns` throws
 * `Cannot read properties of undefined (reading '0')` on a day-of-month that does not occur every month — `0 0 29
 * 2 *` is a legal leap-day schedule that `cronError` accepts and `nextRun` reads fine, and it reached this route as
 * an unexplained 500 on the ordinary crontab path (an omitted slot). One code path rather than a fallback around a
 * broken one: the search costs ~40 `nextRun` calls, which is nothing against a route that answers once per
 * occurrence, and it removes the whole bug class instead of the one pattern that exposed it.
 */
export function previousRun(cron: string, tz: string | undefined, from: Date): Date | undefined {
  const job = new Cron(cron, { timezone: tz ?? "UTC" });
  // FLOORED TO THE SECOND FIRST, and that is the whole correctness of this function. croner strips milliseconds, so
  // any reference inside the second an occurrence began — `10:00:00.300` for a `0 * * * *` — would land before it.
  // That is precisely where a crontab lands: cron wakes at the instant, the process starts, the request arrives some
  // hundreds of milliseconds later. The second an occurrence began IS that occurrence.
  const target = Math.floor(from.getTime() / 1000) * 1000;
  /** The first occurrence strictly after `afterMs`, when one exists at or before the target. */
  const firstAfter = (afterMs: number): Date | undefined => {
    const next = job.nextRun(new Date(afterMs));
    return next !== null && next.getTime() <= target ? next : undefined;
  };
  // `firstAfter` is TRUE below the answer and FALSE from it on, which is what makes the search valid: an occurrence
  // exists in `(x, target]` exactly while `x` is before the last one. The boundary `lo` is one millisecond under it.
  let lo = target - MAX_LOOKBACK_MS;
  if (!firstAfter(lo)) return undefined; // nothing in the window — or the expression has not fired at all
  let hi = target; // `nextRun(target)` is strictly after it, so the predicate is false here by construction
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (firstAfter(mid)) lo = mid;
    else hi = mid;
  }
  return firstAfter(lo);
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
