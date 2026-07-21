import { describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  MAX_PENDING_WAKEUPS,
  MAX_WAKE_ATTEMPTS,
  MIN_WAKE_MS,
  addWakeup,
  deferWakeup,
  listWakeups,
  removeWakeup,
  takeFirstDueWakeup,
} from "../src/schedule/wakeups.ts";
import { makeWakeTool, parseDelayMs, withWakeTool } from "../src/engines/pi/wake-tool.ts";
import { scheduleFile, writeScheduleFile } from "../src/schedule/state.ts";
import { turnContext } from "../src/engines/pi/tool-context.ts";

const root = (): Promise<string> => mkdtemp(join(tmpdir(), "fa-wake-"));
const NOW = new Date("2026-07-07T12:00:00Z");
const at = (ms: number): Date => new Date(NOW.getTime() + ms);
const contextFor = (session: string) => ({
  cwd: process.cwd(),
  sessionManager: {
    getSessionId: () => session,
    getHeader: async () => ({ id: session, timestamp: NOW.toISOString() }),
    getBranch: async () => [],
  },
});

type RawExecute = (id: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;
const exec = (tool: { execute?: unknown }, params: unknown): Promise<unknown> =>
  (tool as unknown as { execute: RawExecute }).execute("c", params);

describe("schedule/wakeups store + guardrails", () => {
  it("addWakeup persists a wake-up; listWakeups returns it", async () => {
    const r = await root();
    expect(addWakeup(r, { session: "s1", prompt: "check", fireAt: at(2 * MIN_WAKE_MS) }, NOW).ok).toBe(true);
    expect(listWakeups(r)).toHaveLength(1);
    expect(listWakeups(r)[0]).toMatchObject({ session: "s1", prompt: "check" });
  });

  it("rejects a delay below the minimum (records nothing)", async () => {
    const r = await root();
    const res = addWakeup(r, { session: "s1", prompt: "x", fireAt: at(1000) }, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/too soon/);
    expect(listWakeups(r)).toHaveLength(0);
  });

  it("rejects past the pending cap", async () => {
    const r = await root();
    for (let i = 0; i < MAX_PENDING_WAKEUPS; i++) {
      addWakeup(r, { session: "s", prompt: `${i}`, fireAt: at(2 * MIN_WAKE_MS) }, NOW);
    }
    const res = addWakeup(r, { session: "s", prompt: "over", fireAt: at(2 * MIN_WAKE_MS) }, NOW);
    expect(res.ok).toBe(false);
    // The rejection lists the pending ids — "unwake one" is only actionable if the model HAS them (the
    // ids were returned when set, but that can be buried far back in the conversation).
    if (!res.ok) {
      expect(res.error).toMatch(/too many/);
      for (const w of listWakeups(r)) expect(res.error).toContain(w.id);
    }
  });

  it("takeFirstDueWakeup claims ONE due (remove+return), leaves future ones, then undefined", async () => {
    const r = await root();
    addWakeup(r, { session: "due", prompt: "now", fireAt: at(2 * MIN_WAKE_MS) }, NOW);
    addWakeup(r, { session: "later", prompt: "later", fireAt: at(60 * MIN_WAKE_MS) }, NOW);
    const when = at(3 * MIN_WAKE_MS); // the first is due, the second not
    expect(takeFirstDueWakeup(r, when)?.session).toBe("due");
    expect(listWakeups(r).map((w) => w.session)).toEqual(["later"]); // due one removed (claimed)
    expect(takeFirstDueWakeup(r, when)).toBeUndefined(); // nothing else due
  });

  it("recurring: a valid cron is accepted; too-frequent and never-firing crons are rejected", async () => {
    const r = await root();
    const daily = addWakeup(r, { session: "s", prompt: "x", fireAt: at(2 * MIN_WAKE_MS), cron: "0 9 * * *" }, NOW);
    expect(daily.ok).toBe(true);
    expect(listWakeups(r)[0]).toMatchObject({ cron: "0 9 * * *" });

    const everyMinute = addWakeup(r, { session: "s", prompt: "x", fireAt: at(0), cron: "* * * * *" }, NOW);
    expect(everyMinute.ok).toBe(false); // < the 10-min recurring floor — a forever token burner
    if (!everyMinute.ok) expect(everyMinute.error).toMatch(/too frequent/);

    const bad = addWakeup(r, { session: "s", prompt: "x", fireAt: at(0), cron: "not a cron" }, NOW);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/invalid cron/);
  });

  it("removeWakeup: session-scoped for the agent's unwake; unscoped for the operator", async () => {
    const r = await root();
    const res = addWakeup(r, { session: "mine", prompt: "x", fireAt: at(2 * MIN_WAKE_MS) }, NOW);
    if (!res.ok) throw new Error("setup");
    expect(removeWakeup(r, res.id, "other-session")).toBe(false); // another conversation can't cancel it
    expect(removeWakeup(r, res.id, "mine")).toBe(true); // its own can
    const res2 = addWakeup(r, { session: "mine", prompt: "x", fireAt: at(2 * MIN_WAKE_MS) }, NOW);
    if (!res2.ok) throw new Error("setup");
    expect(removeWakeup(r, res2.id)).toBe(true); // the operator (no session) always can
  });

  it("recurring claim = ADVANCE IN PLACE: the entry stays (next instant), the occurrence is returned", async () => {
    const r = await root();
    const res = addWakeup(r, { session: "s", prompt: "x", cron: "0 9 * * *", tz: "UTC" }, NOW); // NOW=12:00 → first 09:00 tomorrow
    if (!res.ok) throw new Error("setup");
    const dayAfter = new Date("2026-07-08T09:00:30Z");
    const occurrence = takeFirstDueWakeup(r, dayAfter);
    expect(occurrence).toMatchObject({ id: res.id, fireAt: res.fireAt }); // THIS occurrence, original instant
    // The entry never left the store — unwake/cancel work even mid-fire — and advanced to the next instant.
    expect(listWakeups(r)).toHaveLength(1);
    expect(listWakeups(r)[0]).toMatchObject({ id: res.id, fireAt: "2026-07-09T09:00:00.000Z" });
    // …so the woken turn CAN cancel its own recurrence (the documented unwake flow).
    expect(removeWakeup(r, res.id, "s")).toBe(true);
    expect(listWakeups(r)).toHaveLength(0);
  });

  it("cron fireAt is DERIVED by addWakeup (a caller-passed fireAt cannot disagree with the schedule)", async () => {
    const r = await root();
    const res = addWakeup(r, { session: "s", prompt: "x", fireAt: at(1000), cron: "0 9 * * *", tz: "UTC" }, NOW);
    if (!res.ok) throw new Error("setup");
    expect(res.fireAt).toBe("2026-07-08T09:00:00.000Z"); // next 9am UTC after NOW(12:00) — not the bogus at(1000)
  });

  it("drops a malformed stored entry (bad fireAt) instead of letting it poison the store", async () => {
    const r = await root();
    vi.spyOn(console, "error").mockImplementation(() => {}); // silence the boundary warn
    writeScheduleFile(scheduleFile(r, "wakeups"), [
      { id: "ok", session: "s", prompt: "x", fireAt: at(2 * MIN_WAKE_MS).toISOString() },
      { id: "bad", session: "s", prompt: "x", fireAt: "not-a-date" }, // NaN <= now = false forever
    ]);
    expect(listWakeups(r).map((w) => w.id)).toEqual(["ok"]); // malformed one filtered out at the boundary
    vi.restoreAllMocks();
  });

  it("deferWakeup re-schedules a busy wake, then drops it after the attempt cap", async () => {
    const r = await root();
    const w = { id: "w1", session: "s", prompt: "x", fireAt: at(0).toISOString() };
    expect(deferWakeup(r, w, at(MIN_WAKE_MS))).toBe(true); // attempts 0 → 1, re-added
    expect(listWakeups(r)[0]).toMatchObject({ id: "w1", attempts: 1 });
    // at the cap, deferring drops it (returns false, not re-added)
    expect(deferWakeup(r, { ...w, attempts: MAX_WAKE_ATTEMPTS }, at(MIN_WAKE_MS))).toBe(false);
  });
});

describe("schedule/wake-tool", () => {
  it("parseDelayMs: a unit is REQUIRED on strings; a number is seconds; one scale, no alias", () => {
    expect(parseDelayMs("30m")).toBe(30 * 60_000);
    expect(parseDelayMs("2h")).toBe(2 * 3_600_000);
    expect(parseDelayMs("1d")).toBe(86_400_000);
    expect(parseDelayMs("90s")).toBe(90_000);
    expect(parseDelayMs(120)).toBe(120_000); // a number is seconds
    expect(parseDelayMs("120")).toBeUndefined(); // a bare numeric string is REJECTED (no 120s/120min alias)
    expect(parseDelayMs("soon")).toBeUndefined();
    expect(parseDelayMs(-5)).toBeUndefined();
  });

  it("withWakeTool: wake+unwake mount as a PAIR; an author's either-name tool suppresses BOTH built-ins", () => {
    const base = [{ name: "read" }] as AgentTool[];
    expect(withWakeTool(base, "/r", false).map((t) => t.name)).toEqual(["read"]); // disabled (invoke/fire) → none
    expect(withWakeTool(base, "/r", true).map((t) => t.name)).toEqual(["read", "wake", "unwake"]); // serving
    // The pair is ONE concept over one store: an author's wake doesn't write our store, so our unwake
    // could never cancel what it returns — mixing halves would mislead. Either name → neither built-in.
    const own = [{ name: "read" }, { name: "wake" }] as AgentTool[];
    expect(withWakeTool(own, "/r", true).map((t) => t.name)).toEqual(["read", "wake"]);
  });

  it("the wake tool records a wake-up into the CURRENT session", async () => {
    const r = await root();
    const tool = makeWakeTool(r, () => NOW);
    await turnContext.run(contextFor("conv-1"), () => exec(tool, { in: "30m", prompt: "resume the check" }));
    expect(listWakeups(r)).toHaveLength(1);
    expect(listWakeups(r)[0]).toMatchObject({ session: "conv-1", prompt: "resume the check" });
  });

  it("wake outside a session records nothing (returns a message)", async () => {
    const r = await root();
    await exec(
      makeWakeTool(r, () => NOW),
      { in: "30m", prompt: "x" },
    ); // no turnContext
    expect(listWakeups(r)).toHaveLength(0);
  });

  it("a below-minimum delay is a guardrail message, records nothing", async () => {
    const r = await root();
    const tool = makeWakeTool(r, () => NOW);
    await turnContext.run(contextFor("s"), () => exec(tool, { in: "1s", prompt: "x" }));
    expect(listWakeups(r)).toHaveLength(0);
  });
});
