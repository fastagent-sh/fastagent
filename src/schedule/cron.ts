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
 * How long one occurrence of this expression LASTS — the gap between the next two, measured from `from`.
 *
 * This is the schedule's own rate, and the only thing `POST /trigger` needs the grid for. It is NOT a position: the
 * clock says which occurrence a delivery is for (the industry's shape — EventBridge's `<aws.scheduler.scheduled-
 * time>`, Cloudflare's `controller.scheduledTime`), and a receiver that recomputed the position would be holding a
 * second copy of the grid and, worse, disagreeing with the clock about what a retry means.
 *
 * `undefined` when the expression has no two occurrences left to measure.
 *
 * FORWARD ONLY. croner's backward stepper (`previousRuns`) throws `Cannot read properties of undefined (reading
 * '0')` on a day-of-month that is not in every month — `0 0 29 2 *` is a legal leap-day schedule that `cronError`
 * accepts and this function reads fine.
 */
export function occurrencePeriodMs(cron: string, tz: string | undefined, from: Date): number | undefined {
  const first = nextRun(cron, tz, from);
  const second = first && nextRun(cron, tz, first);
  return first && second ? second.getTime() - first.getTime() : undefined;
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
