import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, AgentEvent } from "../src/agent.ts";
import type { LoadedSchedule } from "../src/schedule/schedule.ts";
import { createScheduler, scheduleSession } from "../src/schedule/scheduler.ts";

/** A fake agent that records each invoke's session + text and yields the scripted terminal. */
function recordingAgent(events: AgentEvent[] = [{ type: "completed" }]) {
  const calls: { session: string; text: string }[] = [];
  const agent: Agent = {
    async *invoke(scope, prompt) {
      calls.push({ session: scope.session, text: prompt.text });
      for (const e of events) yield e;
    },
  };
  return { agent, calls };
}

const hourly = (over: Partial<LoadedSchedule> = {}): LoadedSchedule => ({
  name: "job",
  cron: "0 * * * *", // top of every hour
  tz: "UTC",
  prompt: "go",
  ...over,
});

const freshRoot = (): Promise<string> => mkdtemp(join(tmpdir(), "fa-sched-"));
function seedFires(root: string, fires: Record<string, string>): void {
  mkdirSync(join(root, "schedule"), { recursive: true });
  writeFileSync(join(root, "schedule", "fires.json"), JSON.stringify(fires));
}
const readFires = async (root: string): Promise<Record<string, string>> =>
  JSON.parse(await readFile(join(root, "schedule", "fires.json"), "utf8"));

afterEach(() => vi.useRealTimers());

describe("schedule/scheduler: fire algorithm", () => {
  it("a brand-new schedule does NOT back-fire on first start (no fires.json)", async () => {
    const root = await freshRoot();
    const { agent, calls } = recordingAgent();
    // Next hourly instant (11:00) is in the future → arm, don't fire.
    const s = createScheduler({
      agent,
      stateRoot: root,
      schedules: [hourly()],
      now: () => new Date("2026-07-07T10:30:00Z"),
    });
    s.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toHaveLength(0);
    s.stop();
  });

  it("catches up an overdue run ONCE, claims the slot, session = schedule:<name>", async () => {
    const root = await freshRoot();
    seedFires(root, { job: "2026-07-07T08:00:00Z" }); // last fired 08:00; now is past several hourly slots
    const { agent, calls } = recordingAgent();
    const s = createScheduler({
      agent,
      stateRoot: root,
      schedules: [hourly()],
      now: () => new Date("2026-07-07T12:30:00Z"),
    });
    s.start();
    await vi.waitFor(() => expect(calls.length).toBe(1)); // exactly ONE catch-up, not one per missed slot
    expect(calls[0]).toEqual({ session: scheduleSession("job"), text: "go" });
    expect((await readFires(root)).job).toBe("2026-07-07T12:30:00.000Z"); // claimed = now
    s.stop();
  });

  it("fires when the cron instant arrives, then re-arms for the next", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-07T10:30:00Z"));
    const root = await freshRoot();
    const { agent, calls } = recordingAgent();
    const s = createScheduler({ agent, stateRoot: root, schedules: [hourly()] }); // default now = the faked clock
    s.start();
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1000); // → 11:00
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60 * 60_000); // → 12:00
    expect(calls).toHaveLength(2);
    s.stop();
  });

  it("a failed turn still runs and claims the slot (catch-up, not retried)", async () => {
    const root = await freshRoot();
    seedFires(root, { job: "2026-07-07T08:00:00Z" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { agent, calls } = recordingAgent([{ type: "failed", retryable: true, details: "boom" }]);
    const s = createScheduler({
      agent,
      stateRoot: root,
      schedules: [hourly()],
      now: () => new Date("2026-07-07T12:30:00Z"),
    });
    s.start();
    await vi.waitFor(() => expect(calls.length).toBe(1));
    expect((await readFires(root)).job).toBe("2026-07-07T12:30:00.000Z"); // claimed even on failure
    s.stop();
  });
});
