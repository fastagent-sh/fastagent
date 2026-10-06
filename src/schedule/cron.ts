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

/** The minimum gap between two consecutive fires of anything recurring: a schedule, or a recurring wake-up. */
const MIN_RECURRING_GAP_MS = 10 * 60_000; // 10 minutes

/**
 * Why `cron`/`tz` cannot be something that recurs here, or undefined if it can: THE guard every recurring producer
 * shares (a `schedules/` file, a recurring `wake`), because the agent can write both, and one written wrong must not
 * run turns back to back. The gap between the next two instants must be at least {@link MIN_RECURRING_GAP_MS}; that
 * also refuses croner's six-field, per-second form.
 */
export function recurringCronError(cron: string, tz: string | undefined, now: Date): string | undefined {
  const invalid = cronError(cron, tz);
  if (invalid) return `invalid cron/tz: ${invalid}`;
  const first = nextRun(cron, tz, now);
  const second = first && nextRun(cron, tz, first);
  if (!first || !second) return "this cron never fires, or fires only once";
  if (second.getTime() - first.getTime() < MIN_RECURRING_GAP_MS) {
    return `too frequent — it must fire at most every ${MIN_RECURRING_GAP_MS / 60_000} minutes`;
  }
  return undefined;
}
