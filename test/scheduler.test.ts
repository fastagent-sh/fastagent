import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, AgentEvent } from "../src/agent.ts";
import type { LoadedSchedule } from "../src/schedule/schedule.ts";
import { createScheduler, scheduleSession } from "../src/schedule/scheduler.ts";
import { MAX_WAKE_ATTEMPTS, addWakeup, listWakeups } from "../src/schedule/wakeups.ts";
import { readRuns } from "../src/schedule/audit.ts";

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
    // The run audit recorded the fire: name, outcome, and the reply's audit copy.
    await vi.waitFor(() => expect(readRuns(root, "job")).toHaveLength(1));
    expect(readRuns(root, "job")[0]).toMatchObject({ outcome: "completed", session: scheduleSession("job") });
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

  it("a state-IO fault at fire time skips the run and keeps the schedule armed (no unhandled rejection)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-07T10:30:00Z"));
    const root = await freshRoot();
    const { agent, calls } = recordingAgent();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = createScheduler({ agent, stateRoot: root, schedules: [hourly()] });
    s.start();
    // Sabotage the fire state AFTER arming: a directory at fires.json makes loadFires throw (EISDIR — the
    // unreadable-state class state.ts throws on by design). fireThenReArm is void-scheduled from a timer,
    // so without its totality boundary this would be an unhandled rejection = the whole service down.
    mkdirSync(join(root, "schedule", "fires.json"), { recursive: true });
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1000); // → 11:00: the fire attempt hits the fault
    expect(calls).toHaveLength(0); // skipped (no claim persistable), not half-fired
    expect(errors.mock.calls.some((c) => String(c[0]).includes("fire failed"))).toBe(true);
    // The skip is AUDITED (runs.jsonl is a different file than the broken fires.json) — `schedule history`
    // must see it, not only stderr.
    expect(readRuns(root, "job")[0]).toMatchObject({ outcome: "failed", error: expect.stringMatching(/skipped/) });
    rmdirSync(join(root, "schedule", "fires.json")); // the operator fixes the state…
    await vi.advanceTimersByTimeAsync(60 * 60_000); // → 12:00
    expect(calls).toHaveLength(1); // …and the schedule is STILL armed — the fault cost one run, not the service
    s.stop();
  });

  it("polls and fires a due self-scheduled wake-up into its session, then removes it", async () => {
    const root = await freshRoot();
    // Seed a wake-up that is due by the scheduler's clock (set at 10:00 for 11:00; scheduler runs at 12:00).
    addWakeup(
      root,
      { session: "conv-9", prompt: "resume", fireAt: new Date("2026-07-07T11:00:00Z") },
      new Date("2026-07-07T10:00:00Z"),
    );
    const { agent, calls } = recordingAgent();
    const s = createScheduler({ agent, stateRoot: root, schedules: [], now: () => new Date("2026-07-07T12:00:00Z") });
    s.start(); // polls wake-ups immediately on start
    await vi.waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]?.session).toBe("conv-9"); // fired back into the wake-up's session
    // The prompt arrives ENVELOPED (id + "not a user message") so the model can tell its own alarm from
    // the user speaking; the instruction itself rides along.
    expect(calls[0]?.text).toMatch(
      /^\[wake-up [0-9a-f-]+ fired — YOUR self-scheduled turn, not a user message\] resume$/,
    );
    expect(listWakeups(root)).toHaveLength(0); // claimed + fired, not left pending
    s.stop();
  });

  it("a wake into a BUSY session is deferred (re-scheduled), not lost", async () => {
    const root = await freshRoot();
    addWakeup(
      root,
      { session: "busy", prompt: "resume", fireAt: new Date("2026-07-07T11:00:00Z") },
      new Date("2026-07-07T10:00:00Z"),
    );
    // The turn fails retryably (its session is busy — a channel is mid-turn on it).
    const { agent, calls } = recordingAgent([
      { type: "failed", retryable: true, code: "session_busy", details: "busy" },
    ]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const s = createScheduler({ agent, stateRoot: root, schedules: [], now: () => new Date("2026-07-07T12:00:00Z") });
    s.start();
    await vi.waitFor(() => expect(calls.length).toBe(1));
    // NOT dropped: re-scheduled (deferred) with a bumped attempt count — a one-shot wake must not vanish.
    await vi.waitFor(() => expect(listWakeups(root)).toHaveLength(1));
    expect(listWakeups(root)[0]).toMatchObject({ session: "busy", attempts: 1 });
    // Audited as deferred (not failed): honest — the wake was re-scheduled, not finally lost.
    expect(readRuns(root, "wake")[0]).toMatchObject({ outcome: "deferred", session: "busy" });
    s.stop();
  });

  it("a NON-busy retryable failure is terminal (dropped, not replayed — side effects may have run)", async () => {
    const root = await freshRoot();
    addWakeup(
      root,
      { session: "s", prompt: "go", fireAt: new Date("2026-07-07T11:00:00Z") },
      new Date("2026-07-07T10:00:00Z"),
    );
    // Retryable, but a mid-turn transient (a 429), NOT the busy case: the turn started — don't re-run it.
    const { agent } = recordingAgent([{ type: "failed", retryable: true, details: "provider 429" }]);
    const errs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m) => {
      errs.push(String(m));
    });
    const s = createScheduler({ agent, stateRoot: root, schedules: [], now: () => new Date("2026-07-07T12:00:00Z") });
    s.start();
    // Wait for the turn's FAILURE to be processed (its log) so the defer/drop decision has definitely run
    // — not a bare sleep: listWakeups is 0 right after the claim too, before that decision.
    await vi.waitFor(() => expect(errs.some((e) => /wake .* failed/.test(e))).toBe(true));
    expect(listWakeups(root)).toHaveLength(0); // dropped — a non-busy failure is not re-added (no replay)
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
    // The audit's FAIL path — the branch the audit exists to answer: outcome failed, the error captured.
    await vi.waitFor(() => expect(readRuns(root, "job")).toHaveLength(1));
    expect(readRuns(root, "job")[0]).toMatchObject({ outcome: "failed", error: "boom" });
    expect(readRuns(root, "job")[0]?.reply).toBeUndefined(); // no reply copy on a failed run
    s.stop();
  });

  it("a RECURRING wake fires and re-arms at the next cron instant (same id, attempts reset)", async () => {
    const root = await freshRoot();
    mkdirSync(join(root, "schedule"), { recursive: true });
    writeFileSync(
      join(root, "schedule", "wakeups.json"),
      JSON.stringify([
        {
          id: "rec1",
          session: "s",
          prompt: "daily check",
          fireAt: "2026-07-07T09:00:00Z",
          cron: "0 9 * * *",
          tz: "UTC",
        },
      ]),
    );
    const { agent, calls } = recordingAgent();
    const s = createScheduler({ agent, stateRoot: root, schedules: [], now: () => new Date("2026-07-07T09:00:30Z") });
    s.start();
    await vi.waitFor(() => expect(calls.length).toBe(1)); // fired
    // A recurring envelope carries the id AND the unwake instruction — the documented way to stop it is
    // from inside a woken turn, which otherwise has no way to know its own id.
    expect(calls[0]?.text).toContain('unwake({ id: "rec1" })');
    expect(calls[0]?.text).toContain("daily check");
    await vi.waitFor(() => expect(listWakeups(root)).toHaveLength(1)); // NOT consumed — re-armed
    expect(listWakeups(root)[0]).toMatchObject({ id: "rec1", cron: "0 9 * * *" });
    expect(listWakeups(root)[0]?.fireAt).toBe("2026-07-08T09:00:00.000Z"); // next daily instant
    s.stop();
  });

  it("a busy RECURRING occurrence is SKIPPED (audited failed) — the recurrence continues untouched", async () => {
    const root = await freshRoot();
    mkdirSync(join(root, "schedule"), { recursive: true });
    writeFileSync(
      join(root, "schedule", "wakeups.json"),
      JSON.stringify([
        { id: "rec2", session: "s", prompt: "go", fireAt: "2026-07-07T09:00:00Z", cron: "0 9 * * *", tz: "UTC" },
      ]),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { agent, calls } = recordingAgent([
      { type: "failed", retryable: true, code: "session_busy", details: "busy" },
    ]);
    const s = createScheduler({ agent, stateRoot: root, schedules: [], now: () => new Date("2026-07-07T10:00:00Z") });
    s.start();
    await vi.waitFor(() => expect(calls.length).toBe(1));
    // The recurrence survives (the CLAIM advanced it in place); THIS occurrence is audited failed (skipped),
    // never deferred — a recurring has a next occurrence by definition.
    expect(listWakeups(root)).toHaveLength(1);
    expect(listWakeups(root)[0]).toMatchObject({ id: "rec2", fireAt: "2026-07-08T09:00:00.000Z" });
    await vi.waitFor(() => expect(readRuns(root, "wake")).toHaveLength(1));
    expect(readRuns(root, "wake")[0]).toMatchObject({
      outcome: "failed",
      error: expect.stringMatching(/occurrence skipped/),
    });
    s.stop();
  });

  it("a busy wake dropped at the retry ceiling is audited FAILED (a final silent loss), not deferred", async () => {
    const root = await freshRoot();
    // Seed the wake already AT the attempt cap — the next busy defer drops it.
    mkdirSync(join(root, "schedule"), { recursive: true });
    writeFileSync(
      join(root, "schedule", "wakeups.json"),
      JSON.stringify([
        { id: "w9", session: "s", prompt: "go", fireAt: "2026-07-07T11:00:00Z", attempts: MAX_WAKE_ATTEMPTS },
      ]),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { agent, calls } = recordingAgent([
      { type: "failed", retryable: true, code: "session_busy", details: "busy" },
    ]);
    const s = createScheduler({ agent, stateRoot: root, schedules: [], now: () => new Date("2026-07-07T12:00:00Z") });
    s.start();
    await vi.waitFor(() => expect(calls.length).toBe(1));
    await vi.waitFor(() => expect(readRuns(root, "wake")).toHaveLength(1));
    expect(readRuns(root, "wake")[0]).toMatchObject({
      outcome: "failed",
      error: expect.stringMatching(/dropped after too many/),
    });
    expect(listWakeups(root)).toHaveLength(0); // gone — that's exactly why the audit must say failed
    s.stop();
  });
});
