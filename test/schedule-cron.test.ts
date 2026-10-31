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

  // What docs/configuration.md says a resident host does at a DST change. Only croner's side is run here. EventBridge's
  // is AWS's documentation (it skips a spring time that does not exist and runs once when the clock goes back), and
  // the reading of that for several times in the repeated hour is not tested against a live schedule. The difference
  // is croner's, and croner changed it in 11.
  describe("at a DST change (America/New_York, 2026)", () => {
    const zone = "America/New_York";
    const fires = (cron: string, from: string, until: string): string[] => {
      const out: string[] = [];
      for (let at = nextRun(cron, zone, new Date(from)); at && at <= new Date(until); at = nextRun(cron, zone, at)) {
        out.push(at.toISOString().slice(5, 16));
      }
      return out;
    };

    it("a time the spring change removes runs at the first valid time after the gap", () => {
      // 02:30 does not exist on 8 March; 03:00 EDT is 07:00 UTC, and EventBridge runs nothing.
      expect(fires("30 2 * * *", "2026-03-08T05:00:00Z", "2026-03-08T12:00:00Z")).toEqual(["03-08T07:00"]);
      // An interval skips the gap and adds nothing.
      expect(fires("*/30 * * * *", "2026-03-08T06:29:00Z", "2026-03-08T07:30:00Z")).toEqual([
        "03-08T06:30",
        "03-08T07:00",
        "03-08T07:30",
      ]);
    });

    it("one time in the hour the autumn change repeats runs once", () => {
      expect(fires("30 1 * * *", "2026-11-01T04:00:00Z", "2026-11-01T09:00:00Z")).toEqual(["11-01T05:30"]);
    });

    it("a schedule with several times runs both passes of that hour, where EventBridge runs it once", () => {
      expect(fires("*/15 * * * *", "2026-11-01T04:50:00Z", "2026-11-01T06:50:00Z")).toEqual(
        [
          ...["05:00", "05:15", "05:30", "05:45"], // 01:00-01:45 EDT
          ...["06:00", "06:15", "06:30", "06:45"], // 01:00-01:45 EST, the repeat
        ].map((time) => `11-01T${time}`),
      );
      // Which can put two instants closer than the expression says, which recurringCronError does not refuse.
      expect(recurringCronError("0,55 1 * * *", zone)).toBeUndefined();
      expect(fires("0,55 1 * * *", "2026-11-01T05:30:00Z", "2026-11-01T06:10:00Z")).toEqual([
        "11-01T05:55",
        "11-01T06:00",
      ]);
    });
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
