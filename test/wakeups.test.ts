import { describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import {
  MAX_PENDING_WAKEUPS,
  MIN_WAKE_MS,
  addWakeup,
  listWakeups,
  removeWakeup,
  takeFirstDueWakeup,
  parseDelayMs,
} from "../src/schedule/wakeups.ts";
import { wakeExtension } from "../src/harnesses/pi-durable/wake.ts";
import { scheduleFile, writeScheduleFile } from "../src/schedule/state.ts";

const root = (): Promise<string> => mkdtemp(join(tmpdir(), "fa-wake-"));
const NOW = new Date("2026-07-07T12:00:00Z");
const at = (ms: number): Date => new Date(NOW.getTime() + ms);
/**
 * The wake tool over `stateRoot`, run as in conversation 1 of storage "inc" (session "inc.1"), or in a conversation a
 * task owns (a subagent's), which is no session.
 */
const wake = (stateRoot: string, params: unknown, owned = false, ticking?: () => boolean) => {
  const tool = wakeExtension(stateRoot, { now: () => NOW, ...(ticking ? { ticking } : {}) }).tools?.find(
    ({ name }) => name === "wake",
  ) as ToolRegistration;
  const api = {
    conversationId: 1,
    snapshot: async () => ({ incarnation: "inc" }),
    commit: async (change: (tx: unknown) => unknown) =>
      change({ conversation: async (id: number) => ({ id, ...(owned ? { owner: { taskId: 5 } } : {}) }) }),
  };
  return tool.execute(params as never, api as never, {} as never);
};

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

  it("removeWakeup is session-scoped, with no way around it", async () => {
    // `unwake` is the ONLY caller: an agent cancels its own alarm. The operator CLI that used to pass no
    // session is gone — a wake-up fires only while a serve is running, and a running serve is one whose
    // session can be spoken to, so "the alarm is loose" and "the agent is unreachable" cannot both hold.
    const r = await root();
    const res = addWakeup(r, { session: "mine", prompt: "x", fireAt: at(2 * MIN_WAKE_MS) }, NOW);
    if (!res.ok) throw new Error("setup");
    expect(removeWakeup(r, res.id, "other-session")).toBe(false); // another conversation can't cancel it
    expect(removeWakeup(r, res.id, "mine")).toBe(true); // its own can
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

  it("the wake tool records a wake-up into the CURRENT session", async () => {
    const r = await root();
    await wake(r, { in: "30m", prompt: "resume the check" });
    expect(listWakeups(r)).toHaveLength(1);
    expect(listWakeups(r)[0]).toMatchObject({ session: "inc.1", prompt: "resume the check" });
  });

  it("wake in a conversation that is no session (a subagent's) records nothing, and says why", async () => {
    const r = await root();
    expect(await wake(r, { in: "30m", prompt: "x" }, true)).toMatchObject({ isError: true });
    expect(listWakeups(r)).toHaveLength(0);
  });

  it("a wake-up no clock would fire is refused and recorded nowhere; one a running clock fires is kept", async () => {
    const r = await root();
    let ticking = false;
    expect(await wake(r, { in: "30m", prompt: "x" }, false, () => ticking)).toMatchObject({
      isError: true,
      output: [{ text: expect.stringContaining("nothing fires wake-ups for this agent now") }],
    });
    expect(listWakeups(r)).toHaveLength(0);
    ticking = true;
    expect(await wake(r, { in: "30m", prompt: "x" }, false, () => ticking)).not.toHaveProperty("isError");
    expect(listWakeups(r)).toHaveLength(1);
  });

  it("a below-minimum delay is a guardrail message, records nothing", async () => {
    const r = await root();
    expect(await wake(r, { in: "1s", prompt: "x" })).toMatchObject({ isError: true });
    expect(listWakeups(r)).toHaveLength(0);
  });
});
