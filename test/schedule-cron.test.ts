import { describe, expect, it } from "vitest";
import { cronError, nextRun, previousRun } from "../src/schedule/cron.ts";

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

  it("previousRun is the most recent instant AT OR BEFORE `from`, in the schedule's own zone", () => {
    const at = (iso: string, cron = "0 9 * * *", tz: string | undefined = "America/New_York") =>
      previousRun(cron, tz, new Date(iso))?.toISOString();
    // Landing exactly ON an occurrence means THAT occurrence — the external clock that computed the
    // same grid we did is the ordinary caller here.
    expect(at("2026-07-07T13:00:00.000Z")).toBe("2026-07-07T13:00:00.000Z");
    // …and anywhere inside the second it began, which is where a crontab-launched request lands.
    expect(at("2026-07-07T13:00:00.300Z")).toBe("2026-07-07T13:00:00.000Z");
    expect(at("2026-07-07T13:00:00.999Z")).toBe("2026-07-07T13:00:00.000Z");
    // A moment before it is the PREVIOUS day's, not this one's.
    expect(at("2026-07-07T12:59:59.999Z")).toBe("2026-07-06T13:00:00.000Z");
    // Omitted tz is UTC, not the host's zone — the same rule `nextRun` follows.
    expect(previousRun("0 9 * * *", undefined, new Date("2026-07-07T10:30:00Z"))?.toISOString()).toBe(
      "2026-07-07T09:00:00.000Z",
    );
  });

  it("previousRun is undefined when the expression has never fired by then", () => {
    // The branch `POST /trigger` answers 409 on: a caller omitted the slot, and there is no occurrence
    // to snap to. Reachable with croner's 7-field form (sec min hour dom mon dow year) — this schedule
    // has not begun.
    expect(previousRun("0 0 9 * * * 2099", "UTC", new Date("2026-07-07T00:00:00Z"))).toBeUndefined();
    // Sanity: the same expression DOES resolve once its year has arrived, so the undefined above is
    // the year gating it rather than the expression being unusable.
    expect(previousRun("0 0 9 * * * 2099", "UTC", new Date("2099-07-07T12:00:00Z"))?.toISOString()).toBe(
      "2099-07-07T09:00:00.000Z",
    );
  });

  it("cronError: undefined for valid, a message for an invalid pattern or timezone", () => {
    expect(cronError("0 9 * * *", "UTC")).toBeUndefined();
    expect(cronError("not a cron", undefined)).toBeTruthy();
    expect(cronError("0 9 * * *", "Not/AZone")).toBeTruthy();
  });
});
