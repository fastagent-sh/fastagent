import { describe, expect, it } from "vitest";
import { cronError, nextRun, recurringCronError } from "../src/schedule/cron.ts";

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

  it("cronError: undefined for valid, a message for an invalid pattern or timezone", () => {
    expect(cronError("0 9 * * *", "UTC")).toBeUndefined();
    expect(cronError("not a cron", undefined)).toBeTruthy();
    expect(cronError("0 9 * * *", "Not/AZone")).toBeTruthy();
  });

  it("recurringCronError: a verdict on the expression alone, whatever hour it is asked in", () => {
    const frequent = /^too frequent — it must fire at most every 10 minutes/;
    for (const ok of ["*/10 * * * *", "0 9 * * 1-5", "55 23 * * *", "0 0 29 2 *", "@hourly"]) {
      expect(recurringCronError(ok, undefined), ok).toBeUndefined();
    }
    // Five minutes apart only between 09:00 and 09:05: a check from "now" passed it inside that window.
    expect(recurringCronError("0,5 9 * * *", undefined)).toMatch(frequent);
    expect(recurringCronError("0,55 0,23 * * *", "Asia/Shanghai")).toMatch(frequent); // 23:55 → 00:00
    expect(recurringCronError("* * * * * *", undefined)).toMatch(frequent); // croner's per-second form
    expect(recurringCronError("0 0 0 1 1 * 2030", undefined)).toMatch(/year field is not allowed/);
    expect(recurringCronError("0 0 30 2 *", undefined)).toMatch(/never fires/);
    expect(recurringCronError("0 9 * * *", "Not/AZone")).toMatch(/^invalid cron\/tz/);
  });
});
