import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, AgentEvent } from "../src/agent.ts";
import type { LoadedSchedule } from "../src/schedule/schedule.ts";
import * as Effect from "effect/Effect";
import { createScheduler as scheduler, fireScheduleOnce as fire, scheduleSession } from "../src/schedule/scheduler.ts";

const createScheduler = (options: Parameters<typeof scheduler>[0]) => Effect.runSync(scheduler(options));
const fireScheduleOnce = (options: Parameters<typeof fire>[0]) => Effect.runPromise(fire(options));
import { MAX_WAKE_ATTEMPTS, addWakeup, listWakeups } from "../src/schedule/wakeups.ts";
import { appendRun, readRuns } from "../src/schedule/audit.ts";
import { latestFire } from "../src/schedule/state.ts";

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

/** The audit record a healthy prior fire left behind — without it a seeded claim reads as interrupted. */
function seedRun(root: string, name: string, firedAt: string): void {
  appendRun(root, { name, session: scheduleSession(name), firedAt, ms: 1, outcome: "completed" });
}
/** Write the claim a fire leaves: the slot's file, stamped with when it was taken. */
const seedClaim = (root: string, name: string, firedAt: string, slot = firedAt): void => {
  const dir = join(root, "schedule", "claims", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, slot.replace(/[:.]/g, "-")), firedAt);
};
/** The slots this state root has claimed, oldest first (the decision's own record). */
const claimed = (root: string, name: string): string[] => {
  try {
    return readdirSync(join(root, "schedule", "claims", name)).sort();
  } catch {
    return [];
  }
};
/** When this state root says the schedule last fired — read the way the scheduler reads it. */
const lastFire = (root: string, name: string): string | undefined => latestFire(root, name);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("schedule/scheduler: fire algorithm", () => {
  it("a brand-new schedule does NOT back-fire on first start (no claim yet)", async () => {
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

  it("records a claim whose turn never reported as interrupted, once, and never re-fires it", async () => {
    const root = await freshRoot();
    const warns: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void warns.push(a.join(" ")));
    // The shape a killed process leaves: the SLOT IS CLAIMED — with the stamp the claim carries — and the audit says
    // nothing about it. `fires.json` is deliberately absent: a process killed between the two writes must still be
    // reconciled, which is why the reconciler reads the claim and not the bookkeeping.
    seedClaim(root, "job", "2026-07-07T10:00:00.000Z");
    const { agent, calls } = recordingAgent();
    const options = {
      agent,
      stateRoot: root,
      schedules: [hourly()],
      now: () => new Date("2026-07-07T10:30:00Z"), // 11:00 is still ahead → no catch-up to confuse this
    };
    const s = createScheduler(options);
    s.start();
    expect(readRuns(root, "job")).toMatchObject([
      { outcome: "interrupted", firedAt: "2026-07-07T10:00:00.000Z", ms: 0 },
    ]);
    expect(warns.some((w) => /never finished/.test(w))).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toHaveLength(0); // accounted for, not replayed
    s.stop();

    // The record it wrote accounts for the same claim, so a later boot stays quiet.
    const again = createScheduler(options);
    again.start();
    expect(readRuns(root, "job")).toHaveLength(1);
    again.stop();
  });

  it("an unusable claim stamp falls back to the slot instant — catch-up may repeat, never skip", async () => {
    // The claim's content is now what catch-up resumes from, so a truncated or corrupt stamp must degrade in the
    // safe direction: the slot in the file name is the earliest the fire can have happened.
    const root = await freshRoot();
    const warns: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void warns.push(a.join(" ")));
    seedClaim(root, "job", "not a timestamp", "2026-07-07T10:00:00.000Z");
    expect(lastFire(root, "job")).toBe("2026-07-07T10:00:00.000Z");
    expect(warns.some((w) => /unreadable stamp/.test(w))).toBe(true);
    // An empty file (killed between the create and the write) takes the same path, without the warning.
    seedClaim(root, "other", "", "2026-07-07T11:00:00.000Z");
    expect(lastFire(root, "other")).toBe("2026-07-07T11:00:00.000Z");
  });

  it("a claim newer than the last audited run is reported, even with older fires on record", async () => {
    // The reconciler compares the newest claim against the newest audit record for that schedule, so a completed
    // history does not hide the fire that came after it and never reported.
    const root = await freshRoot();
    vi.spyOn(console, "error").mockImplementation(() => {});
    seedClaim(root, "job", "2026-07-07T08:00:00Z"); // bookkeeping from the PREVIOUS, completed fire
    seedRun(root, "job", "2026-07-07T08:00:01Z");
    seedClaim(root, "job", "2026-07-07T10:00:00.000Z"); // the fire that was killed
    const { agent } = recordingAgent();
    const s = createScheduler({
      agent,
      stateRoot: root,
      schedules: [hourly()],
      now: () => new Date("2026-07-07T10:30:00Z"),
    });
    s.start();
    expect(readRuns(root, "job").at(-1)).toMatchObject({ outcome: "interrupted", firedAt: "2026-07-07T10:00:00.000Z" });
    s.stop();
  });

  it("refuses a slot older than the newest claim, past the pruning window (a stale platform retry)", async () => {
    // AWS keeps retrying a schedule event for up to 24h, and claims are pruned by count — so "the slot's own claim
    // still exists" cannot be the only gate, or a late retry of an old slot would bill a turn for an instant the
    // schedule has long passed.
    const root = await freshRoot();
    const { agent, calls } = recordingAgent();
    seedClaim(root, "job", "2026-07-07T12:00:03.000Z", "2026-07-07T12:00:00.000Z");
    const stale = await fireScheduleOnce({
      agent,
      stateRoot: root,
      schedule: hourly(),
      slot: new Date("2026-07-07T09:00:00Z"), // its own claim was pruned long ago
      now: () => new Date("2026-07-07T12:30:00Z"),
    });
    expect(stale).toMatchObject({ fired: false, skippedReason: expect.stringContaining("is stale") });
    expect(calls).toHaveLength(0);
  });

  it("an unreadable run audit costs the check, not the schedule", async () => {
    const root = await freshRoot();
    const warns: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void warns.push(a.join(" ")));
    seedClaim(root, "job", "2026-07-07T08:00:00.000Z");
    mkdirSync(join(root, "schedule", "runs.jsonl")); // a directory where the audit should be: EISDIR on read
    const { agent, calls } = recordingAgent();
    const s = createScheduler({
      agent,
      stateRoot: root,
      schedules: [hourly()],
      now: () => new Date("2026-07-07T12:30:00Z"),
    });
    expect(() => s.start()).not.toThrow();
    await vi.waitFor(() => expect(calls).toHaveLength(1)); // the overdue slot still fires
    expect(warns.some((w) => /could not read the run audit/.test(w))).toBe(true);
    s.stop();
  });

  it("a wake-up-only scheduler does not read the audit at all", async () => {
    const root = await freshRoot();
    const warns: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void warns.push(a.join(" ")));
    mkdirSync(join(root, "schedule", "runs.jsonl"), { recursive: true }); // any read of it would fail loudly
    const { agent } = recordingAgent();
    const s = createScheduler({ agent, stateRoot: root, schedules: [], now: () => new Date("2026-07-07T10:30:00Z") });
    s.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(warns).toEqual([]);
    s.stop();
  });

  it("catches up an overdue run ONCE, claims the slot, session = schedule:<name>", async () => {
    const root = await freshRoot();
    seedClaim(root, "job", "2026-07-07T08:00:00Z"); // last fired 08:00; now is past several hourly slots
    seedRun(root, "job", "2026-07-07T08:00:01Z");
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
    expect(lastFire(root, "job")).toBe("2026-07-07T12:30:00.000Z"); // the claim records when it fired
    // The run audit recorded the fire: name, outcome, and the reply's audit copy.
    await vi.waitFor(() => expect(readRuns(root, "job")).toHaveLength(2)); // the seeded prior run, then this one
    expect(readRuns(root, "job").at(-1)).toMatchObject({ outcome: "completed", session: scheduleSession("job") });
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
    // Sabotage the claim state AFTER arming: a FILE where `claims/job/` belongs makes `claimSlot` throw (ENOTDIR —
    // the unreadable-state class state.ts throws on by design), and it throws BEFORE the slot is claimed, so the
    // slot is not burned. fireThenReArm is void-scheduled from a timer, so without its totality boundary this would
    // be an unhandled rejection = the whole service down.
    mkdirSync(join(root, "schedule", "claims"), { recursive: true });
    writeFileSync(join(root, "schedule", "claims", "job"), "");
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1000); // → 11:00: the fire attempt hits the fault
    expect(calls).toHaveLength(0); // skipped (no claim persistable), not half-fired
    expect(errors.mock.calls.some((c) => String(c[0]).includes("fire failed"))).toBe(true);
    // The skip is AUDITED (runs.jsonl is a different file than the broken claim state) — `schedule history`
    // must see it, not only stderr.
    expect(readRuns(root, "job")[0]).toMatchObject({ outcome: "failed", error: expect.stringMatching(/skipped/) });
    rmSync(join(root, "schedule", "claims", "job")); // the operator fixes the state…
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
    seedClaim(root, "job", "2026-07-07T08:00:00Z");
    seedRun(root, "job", "2026-07-07T08:00:01Z");
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
    expect(lastFire(root, "job")).toBe("2026-07-07T12:30:00.000Z"); // claimed even on failure
    // The audit's FAIL path — the branch the audit exists to answer: outcome failed, the error captured.
    await vi.waitFor(() => expect(readRuns(root, "job")).toHaveLength(2)); // the seeded prior run, then this one
    expect(readRuns(root, "job").at(-1)).toMatchObject({ outcome: "failed", error: "boom" });
    expect(readRuns(root, "job").at(-1)?.reply).toBeUndefined(); // no reply copy on a failed run
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

describe("schedule/fireScheduleOnce: the external-clock fire path", () => {
  const slot = new Date("2026-07-07T10:00:00Z");

  it("claims the slot, records when it fired, audits, and returns the outcome", async () => {
    const root = await freshRoot();
    const { agent, calls } = recordingAgent();
    const now = () => new Date("2026-07-07T10:00:03Z");
    const outcome = await fireScheduleOnce({ agent, stateRoot: root, schedule: hourly(), slot, now });
    expect(outcome.fired).toBe(true);
    expect(outcome.failed).toBeUndefined();
    expect(calls).toEqual([{ session: scheduleSession("job"), text: "go" }]);
    // The claim carries WHEN it fired (where catch-up resumes); its NAME is the slot.
    expect(lastFire(root, "job")).toBe("2026-07-07T10:00:03.000Z");
    expect(claimed(root, "job")).toEqual(["2026-07-07T10-00-00-000Z"]);
    expect(readRuns(root, "job")).toHaveLength(1);
  });

  it("skips a duplicate slot delivery (at-least-once external clock → at-most-once fire)", async () => {
    const root = await freshRoot();
    const { agent, calls } = recordingAgent();
    const now = () => new Date("2026-07-07T10:00:03Z");
    await fireScheduleOnce({ agent, stateRoot: root, schedule: hourly(), slot, now });
    const dup = await fireScheduleOnce({ agent, stateRoot: root, schedule: hourly(), slot, now });
    expect(dup.fired).toBe(false);
    expect(dup.skippedReason).toMatch(/is already claimed/);
    expect(calls).toHaveLength(1);
  });

  it("a stale slot is warned AND audited — a planned run that will never happen must be visible", async () => {
    // The way in is a wall clock that moved backwards (a VM resume, a host clock correction): `nextRun` keeps
    // producing slots behind the newest claim, the schedule stops firing, and without a record `schedule history`
    // would show nothing at all. A duplicate delivery is the benign case and stays an info line with no record.
    const root = await freshRoot();
    const warns: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void warns.push(a.join(" ")));
    const { agent, calls } = recordingAgent();
    seedClaim(root, "job", "2026-07-07T12:00:03.000Z", "2026-07-07T12:00:00.000Z");
    const stale = await fireScheduleOnce({
      agent,
      stateRoot: root,
      schedule: hourly(),
      slot: new Date("2026-07-07T09:00:00Z"),
      now: () => new Date("2026-07-07T12:30:00Z"),
    });
    expect(stale.fired).toBe(false);
    expect(calls).toHaveLength(0);
    expect(readRuns(root, "job")).toMatchObject([
      { outcome: "stale", ms: 0, error: expect.stringMatching(/is stale/) },
    ]);
    expect(warns.some((w) => /is stale/.test(w))).toBe(true);

    // The duplicate path stays quiet in the audit: one line per retried delivery would drown the history.
    await fireScheduleOnce({
      agent,
      stateRoot: root,
      schedule: hourly(),
      slot: new Date("2026-07-07T12:00:00Z"),
      now: () => new Date("2026-07-07T12:31:00Z"),
    });
    expect(readRuns(root, "job")).toHaveLength(1);
  });

  it("a LATER slot still fires even when the earlier delivery arrived after it", async () => {
    const root = await freshRoot();
    const { agent, calls } = recordingAgent();
    await fireScheduleOnce({
      agent,
      stateRoot: root,
      schedule: hourly(),
      slot,
      // Delivery lag exceeds the interval to the next distinct slot.
      now: () => new Date("2026-07-07T12:30:00Z"),
    });
    const next = await fireScheduleOnce({
      agent,
      stateRoot: root,
      schedule: hourly(),
      slot: new Date("2026-07-07T11:00:00Z"),
      now: () => new Date("2026-07-07T12:31:00Z"),
    });
    expect(next.fired).toBe(true);
    expect(calls).toHaveLength(2);
    // Two distinct slots, two claims — the later delivery is not shadowed by the earlier one's wall-clock stamp.
    expect(claimed(root, "job")).toEqual(["2026-07-07T10-00-00-000Z", "2026-07-07T11-00-00-000Z"]);
  });

  it("surfaces a failed turn in the outcome and the audit", async () => {
    const root = await freshRoot();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { agent } = recordingAgent([{ type: "failed", retryable: false, details: "model exploded" }]);
    const outcome = await fireScheduleOnce({ agent, stateRoot: root, schedule: hourly(), slot });
    expect(outcome.fired).toBe(true);
    expect(outcome.failed).toBe("model exploded");
    expect(readRuns(root, "job")[0]).toMatchObject({ outcome: "failed", error: "model exploded" });
  });
});

describe("schedule/scheduler: externalClock mode", () => {
  it("arms NO cron timers and does NO boot catch-up — but still pumps wake-ups", async () => {
    const root = await freshRoot();
    // An overdue slot the resident scheduler WOULD catch up: lastFired 09:00, now 10:30 (10:00 missed).
    seedClaim(root, "job", "2026-07-07T09:00:00Z");
    mkdirSync(join(root, "schedule"), { recursive: true });
    writeFileSync(
      join(root, "schedule", "wakeups.json"),
      JSON.stringify([{ id: "w1", session: "s", prompt: "wake!", fireAt: "2026-07-07T10:00:00Z" }]),
    );
    const { agent, calls } = recordingAgent();
    const s = createScheduler({
      agent,
      stateRoot: root,
      schedules: [hourly()],
      now: () => new Date("2026-07-07T10:30:00Z"),
      externalClock: true,
    });
    s.start();
    // The due wake-up fires (the pump runs); the overdue CRON slot does not (the external clock owns it).
    await vi.waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.text).toContain("wake!");
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toHaveLength(1);
    expect(lastFire(root, "job")).toBe("2026-07-07T09:00:00Z"); // untouched — no resident claim
    s.stop();
  });
});
