import { describe, expect, it } from "vitest";
import { cronError, nextRun } from "../src/schedule/cron.ts";

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
});
