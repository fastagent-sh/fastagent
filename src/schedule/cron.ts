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
/** Where the check below starts: fixed, so its verdict is the cron's and never the hour it was asked in. */
const ANCHOR = new Date("2024-01-01T00:00:00Z");
const TWO_DAYS_MS = 2 * 24 * 60 * 60_000;
/** One verdict per expression: the check walks up to ~300 instants, and every re-read of `schedules/` asks again. */
const verdicts = new Map<string, string | undefined>();

/**
 * Why `cron`/`tz` cannot be something that recurs here, or undefined if it can: THE guard every recurring producer
 * shares (a `schedules/` file, a recurring `wake`), because the agent can write both, and one written wrong must not
 * run turns back to back. Two consecutive instants must be at least {@link MIN_RECURRING_GAP_MS} apart, which also
 * refuses croner's six-field, per-second form.
 *
 * A function of the expression alone, so a file's verdict never flips with the time it is read. Two consecutive
 * instants under 10 minutes apart are on one day or across one midnight, and the time-of-day fields repeat every day,
 * so two days of the time-of-day form (the day fields made `*`, in UTC) hold every such gap. That is conservative:
 * `0,55 0,23 * * 1` is refused for the 23:55 → 00:00 pair, though Tuesday never fires. A DST change only lengthens a
 * gap (croner fires a repeated hour once). A year field is refused, since what repeats every year does not need one.
 */
export function recurringCronError(cron: string, tz: string | undefined): string | undefined {
  const key = `${cron}\u0000${tz ?? ""}`;
  if (!verdicts.has(key)) verdicts.set(key, judge(cron, tz));
  return verdicts.get(key);
}

function judge(cron: string, tz: string | undefined): string | undefined {
  const invalid = cronError(cron, tz);
  if (invalid) return `invalid cron/tz: ${invalid}`;
  const fields = cron.trim().split(/\s+/);
  if (fields.length === 7) return "a year field is not allowed: a recurring cron repeats every year";
  const first = nextRun(cron, tz, ANCHOR);
  if (!first || !nextRun(cron, tz, first)) return "this cron never fires, or fires only once";
  // A nickname (`@hourly`) has no fields to separate, and is walked as it is.
  const timeOfDay =
    fields.length === 5
      ? `${fields[0]} ${fields[1]} * * *`
      : fields.length === 6
        ? `${fields[0]} ${fields[1]} ${fields[2]} * * *`
        : cron;
  const clock = new Cron(timeOfDay, { timezone: "UTC" });
  const end = ANCHOR.getTime() + TWO_DAYS_MS;
  for (let at = clock.nextRun(ANCHOR); at && at.getTime() < end; ) {
    const next = clock.nextRun(at);
    if (next && next.getTime() - at.getTime() < MIN_RECURRING_GAP_MS) {
      return `too frequent — it must fire at most every ${MIN_RECURRING_GAP_MS / 60_000} minutes`;
    }
    at = next;
  }
  return undefined;
}
