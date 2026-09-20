import { describe, expect, it } from "vitest";
import { cronError, nextRun, occurrencePeriodMs } from "../src/schedule/cron.ts";

describe("schedule/cron", () => {
  it("nextRun is the next instant STRICTLY AFTER `from`, timezone-aware, UTC by default", () => {
    // 9am America/New_York = 13:00 UTC in July (EDT).
    const n = nextRun("0 9 * * *", "America/New_York", new Date("2026-07-07T00:00:00Z"));
    expect(n?.toISOString()).toBe("2026-07-07T13:00:00.000Z");
    // From that instant, the NEXT one is the following day (strictly after, not the same slot).
    expect(nextRun("0 9 * * *", "America/New_York", n!)?.toISOString()).toBe("2026-07-08T13:00:00.000Z");
    // Omitted tz is UTC, not the host's zone.
    expect(nextRun("0 9 * * *", undefined, new Date("2026-07-07T00:00:00Z"))?.toISOString()).toBe(
      "2026-07-07T09:00:00.000Z",
    );
  });

  it("occurrencePeriodMs is how long one occurrence LASTS — the schedule's own rate", () => {
    // The ONLY thing POST /trigger needs the grid for. Not a POSITION: the clock names which occurrence a
    // delivery is for, and a receiver that recomputed that would disagree with the clock about what a retry is.
    const at = new Date("2026-07-07T10:30:00Z");
    expect(occurrencePeriodMs("* * * * *", "UTC", at)).toBe(60_000);
    expect(occurrencePeriodMs("0 * * * *", "UTC", at)).toBe(3_600_000);
    expect(occurrencePeriodMs("0 9 * * *", "UTC", at)).toBe(86_400_000);
    expect(occurrencePeriodMs("0 9 * * 1", "UTC", at)).toBe(7 * 86_400_000);

    // FORWARD ONLY, which is what lets it read `0 0 29 2 *`. croner's own backward stepper throws
    // `Cannot read properties of undefined (reading '0')` on a day-of-month that is not in every month —
    // a legal leap-day schedule `cronError` accepts and `nextRun` reads fine.
    expect(cronError("0 0 29 2 *", "UTC")).toBeUndefined();
    expect(occurrencePeriodMs("0 0 29 2 *", "UTC", at)).toBe(4 * 365.25 * 86_400_000);

    // A schedule with no two occurrences left to measure has no period.
    expect(occurrencePeriodMs("0 0 30 2 *", "UTC", at)).toBeUndefined();
    expect(occurrencePeriodMs("0 0 9 * * * 2020", "UTC", at)).toBeUndefined();
  });

  it("cronError: undefined for valid, a message for an invalid pattern or timezone", () => {
    expect(cronError("0 9 * * *", "UTC")).toBeUndefined();
    expect(cronError("not a cron", undefined)).toBeTruthy();
    expect(cronError("0 9 * * *", "Not/AZone")).toBeTruthy();
  });
});
