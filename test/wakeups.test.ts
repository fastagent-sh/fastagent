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
  takeFirstDueWakeup,
} from "../src/schedule/wakeups.ts";
import { makeWakeTool, parseDelayMs, withWakeTool } from "../src/engines/pi/wake-tool.ts";
import { scheduleFile, writeScheduleFile } from "../src/schedule/state.ts";
import { turnContext } from "../src/engines/pi/tool-context.ts";

const root = (): Promise<string> => mkdtemp(join(tmpdir(), "fa-wake-"));
const NOW = new Date("2026-07-07T12:00:00Z");
const at = (ms: number): Date => new Date(NOW.getTime() + ms);

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
    if (!res.ok) expect(res.error).toMatch(/too many/);
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

  it("withWakeTool: appends wake only when enabled + absent; the workspace's own wake wins", () => {
    const base = [{ name: "read" }] as AgentTool[];
    expect(withWakeTool(base, "/r", false).map((t) => t.name)).toEqual(["read"]); // disabled (invoke/fire) → no wake
    expect(withWakeTool(base, "/r", true).map((t) => t.name)).toEqual(["read", "wake"]); // serving → mounted
    const own = [{ name: "read" }, { name: "wake" }] as AgentTool[];
    expect(withWakeTool(own, "/r", true).map((t) => t.name)).toEqual(["read", "wake"]); // author's wake wins, no dup
  });

  it("the wake tool records a wake-up into the CURRENT session", async () => {
    const r = await root();
    const tool = makeWakeTool(r, () => NOW);
    await turnContext.run({ session: "conv-1" }, () => exec(tool, { in: "30m", prompt: "resume the check" }));
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
    await turnContext.run({ session: "s" }, () => exec(tool, { in: "1s", prompt: "x" }));
    expect(listWakeups(r)).toHaveLength(0);
  });
});
