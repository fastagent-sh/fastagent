/**
 * The one place that touches the cron library (`croner`). The scheduler owns FIRE control (for
 * durability / overdue catch-up), so it borrows only croner's next-instant computation, not its
 * scheduling. croner is chosen for zero transitive dependencies + built-in IANA timezone/DST handling
 * (wall-clock schedules like "daily 9am America/New_York" need DST-correct arithmetic that hand-rolling
 * gets wrong at the spring-forward / fall-back boundary).
 */
import { Cron } from "croner";

/** The next scheduled instant STRICTLY AFTER `from` (in `tz`, default UTC), or undefined if the
 *  expression will never fire again. */
export function nextRun(cron: string, tz: string | undefined, from: Date): Date | undefined {
  return new Cron(cron, { timezone: tz ?? "UTC" }).nextRun(from) ?? undefined;
}

/** Why `cron`/`tz` is invalid (for load-time validation), or undefined if valid. croner validates the
 *  timezone lazily (not at construction), so check it explicitly via Intl (throws on an unknown IANA
 *  zone); the pattern is validated by constructing the Cron. Both turned into a message, never a throw. */
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
