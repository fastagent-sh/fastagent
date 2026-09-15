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
import { readFires } from "../src/schedule/state.ts";

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

/**
 * Write the claim a fire leaves: the slot's file, stamped with when it was taken — and, unless `settled` is false,
 * the outcome the turn wrote back. An UNSETTLED claim is exactly the shape a killed process leaves behind.
 */
const seedClaim = (root: string, name: string, firedAt: string, slot = firedAt, settled = true): void => {
  const dir = join(root, "schedule", "claims", name);
  mkdirSync(dir, { recursive: true });
  // Through `toISOString` first: a claim file name is the shape `claimSlot` writes, and nothing else is read as one.
  const file = new Date(slot).toISOString().replace(/[:.]/g, "-");
  writeFileSync(join(dir, file), settled ? `${firedAt} completed 1` : firedAt);
};
/** How this state root says the fires for `name` ended. */
const outcomes = (root: string, name: string): (string | undefined)[] => readFires(root, name).map((f) => f.outcome);
/** The slots this state root has claimed, oldest first (the decision's own record). */
const claimed = (root: string, name: string): string[] => {
  try {
    return readdirSync(join(root, "schedule", "claims", name)).sort();
  } catch {
    return [];
  }
};
/** When this state root says the schedule last fired — read the way the scheduler reads it. */
const lastFire = (root: string, name: string): string | undefined => readFires(root, name).at(-1)?.firedAt;

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
    // The shape a killed process leaves: the SLOT IS CLAIMED — with the stamp the claim carries — and no outcome was
    // ever written back into it. The claim is the only file involved: there is no second one that could disagree.
    seedClaim(root, "job", "2026-07-07T10:00:00.000Z", undefined, false);
    const { agent, calls } = recordingAgent();
    const options = {
      agent,
      stateRoot: root,
      schedules: [hourly()],
      now: () => new Date("2026-07-07T10:30:00Z"), // 11:00 is still ahead → no catch-up to confuse this
    };
    const s = createScheduler(options);
    s.start();
    expect(readFires(root, "job")).toMatchObject([
      { outcome: "interrupted", firedAt: "2026-07-07T10:00:00.000Z", ms: 0 },
    ]);
    expect(warns.some((w) => /never finished/.test(w))).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toHaveLength(0); // accounted for, not replayed
    s.stop();

    // The outcome now lives in the claim itself, so a later boot has nothing left to report.
    warns.length = 0;
    const again = createScheduler(options);
    again.start();
    expect(outcomes(root, "job")).toEqual(["interrupted"]); // still one fire, still one outcome
    expect(warns.some((w) => /never finished/.test(w))).toBe(false);
    again.stop();
  });

  it("a file that is not a claim is not read as one — it decides nothing and breaks nothing", async () => {
    // A claims directory is a directory: macOS drops `.DS_Store` into any it opens, and such a name sorts after
    // every real claim. Read as the newest one it would decide whether the next slot is refused as stale, where
    // catch-up resumes, and which fire the reconciler settles — and its slot cannot be parsed back, which used to
    // take `start()` down with `RangeError: Invalid time value`.
    const root = await freshRoot();
    vi.spyOn(console, "error").mockImplementation(() => {});
    seedClaim(root, "job", "2026-07-07T08:00:00Z");
    writeFileSync(join(root, "schedule", "claims", "job", ".DS_Store"), "junk");
    writeFileSync(join(root, "schedule", "claims", "job", "2026-07-07T09-00-00-000Z.tmp"), "half a write");
    const { agent, calls } = recordingAgent();
    const s = createScheduler({
      agent,
      stateRoot: root,
      schedules: [hourly()],
      now: () => new Date("2026-07-07T12:30:00Z"),
    });
    expect(() => s.start()).not.toThrow();
    // The overdue slot still catches up, and both fires on record are the real ones: neither stray file became a
    // fire, and neither was settled as interrupted.
    await vi.waitFor(() => expect(outcomes(root, "job")).toEqual(["completed", "completed"]));
    expect(calls).toHaveLength(1);
    s.stop();
  });

  it("an unusable claim stamp falls back to the slot instant — catch-up may repeat, never skip", async () => {
    // The claim's content is now what catch-up resumes from, so a truncated or corrupt stamp must degrade in the
    // safe direction: the slot in the file name is the earliest the fire can have happened.
    const root = await freshRoot();
    const warns: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void warns.push(a.join(" ")));
    seedClaim(root, "job", "not a timestamp", "2026-07-07T10:00:00.000Z", false);
    expect(lastFire(root, "job")).toBe("2026-07-07T10:00:00.000Z");
    expect(warns.some((w) => /unreadable stamp/.test(w))).toBe(true);
    // An empty file (killed between the create and the write) takes the same path, without the warning.
    seedClaim(root, "other", "", "2026-07-07T11:00:00.000Z", false);
    expect(lastFire(root, "other")).toBe("2026-07-07T11:00:00.000Z");
  });

  it("reports the unsettled claim only — the settled fires beside it stay as they are", async () => {
    // Each claim carries its own outcome, so a completed history neither hides the fire that came after it and never
    // reported, nor gets rewritten by the reconciler.
    const root = await freshRoot();
    vi.spyOn(console, "error").mockImplementation(() => {});
    seedClaim(root, "job", "2026-07-07T08:00:01Z", "2026-07-07T08:00:00Z"); // the PREVIOUS, completed fire
    seedClaim(root, "job", "2026-07-07T10:00:00.000Z", undefined, false); // the fire that was killed
    const { agent } = recordingAgent();
    const s = createScheduler({
      agent,
      stateRoot: root,
      schedules: [hourly()],
      now: () => new Date("2026-07-07T10:30:00Z"),
    });
    s.start();
    expect(outcomes(root, "job")).toEqual(["completed", "interrupted"]);
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

  it("catches up an overdue run ONCE, claims the slot, session = schedule:<name>", async () => {
    const root = await freshRoot();
    seedClaim(root, "job", "2026-07-07T08:00:00Z"); // last fired 08:00; now is past several hourly slots
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
    // The same claim records how it ended — no second file, nothing appended anywhere.
    await vi.waitFor(() => expect(outcomes(root, "job")).toEqual(["completed", "completed"]));
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
    // Only a log line: the fault happens BEFORE a claim exists, so there is nothing to record an outcome in — which
    // is the same fact that keeps the slot unburned.
    expect(errors.mock.calls.some((c) => String(c[0]).includes("fire failed"))).toBe(true);
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
    const logs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    const s = createScheduler({ agent, stateRoot: root, schedules: [], now: () => new Date("2026-07-07T12:00:00Z") });
    s.start();
    await vi.waitFor(() => expect(calls.length).toBe(1));
    // NOT dropped: re-scheduled (deferred) with a bumped attempt count — a one-shot wake must not vanish.
    await vi.waitFor(() => expect(listWakeups(root)).toHaveLength(1));
    expect(listWakeups(root)[0]).toMatchObject({ session: "busy", attempts: 1 });
    // Reported as a retry, not a failure: honest — the wake was re-scheduled, not finally lost. A wake-up has no
    // claim to settle, so this line IS its record.
    expect(logs.some((l) => /session busy — retrying next poll/.test(l))).toBe(true);
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
    // The FAIL path — the branch the history exists to answer: the claim itself says failed (why is in the log).
    await vi.waitFor(() => expect(outcomes(root, "job")).toEqual(["completed", "failed"]));
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

  it("a busy RECURRING occurrence is SKIPPED (reported, never stored) — the recurrence continues untouched", async () => {
    const root = await freshRoot();
    mkdirSync(join(root, "schedule"), { recursive: true });
    writeFileSync(
      join(root, "schedule", "wakeups.json"),
      JSON.stringify([
        { id: "rec2", session: "s", prompt: "go", fireAt: "2026-07-07T09:00:00Z", cron: "0 9 * * *", tz: "UTC" },
      ]),
    );
    const logs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    const { agent, calls } = recordingAgent([
      { type: "failed", retryable: true, code: "session_busy", details: "busy" },
    ]);
    const s = createScheduler({ agent, stateRoot: root, schedules: [], now: () => new Date("2026-07-07T10:00:00Z") });
    s.start();
    await vi.waitFor(() => expect(calls.length).toBe(1));
    // The recurrence survives (the CLAIM advanced it in place); THIS occurrence is reported skipped, never deferred
    // — a recurring has a next occurrence by definition.
    expect(listWakeups(root)).toHaveLength(1);
    expect(listWakeups(root)[0]).toMatchObject({ id: "rec2", fireAt: "2026-07-08T09:00:00.000Z" });
    await vi.waitFor(() => expect(logs.some((l) => /occurrence skipped/.test(l))).toBe(true));
    s.stop();
  });

  it("a busy wake dropped at the retry ceiling is reported as an ERROR (a final silent loss), not deferred", async () => {
    const root = await freshRoot();
    // Seed the wake already AT the attempt cap — the next busy defer drops it.
    mkdirSync(join(root, "schedule"), { recursive: true });
    writeFileSync(
      join(root, "schedule", "wakeups.json"),
      JSON.stringify([
        { id: "w9", session: "s", prompt: "go", fireAt: "2026-07-07T11:00:00Z", attempts: MAX_WAKE_ATTEMPTS },
      ]),
    );
    const logs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    const { agent, calls } = recordingAgent([
      { type: "failed", retryable: true, code: "session_busy", details: "busy" },
    ]);
    const s = createScheduler({ agent, stateRoot: root, schedules: [], now: () => new Date("2026-07-07T12:00:00Z") });
    s.start();
    await vi.waitFor(() => expect(calls.length).toBe(1));
    await vi.waitFor(() => expect(logs.some((l) => /dropped after too many/.test(l))).toBe(true));
    expect(listWakeups(root)).toHaveLength(0); // gone — that's exactly why the drop must be reported as an error
    s.stop();
  });
});

describe("schedule/fireScheduleOnce: the external-clock fire path", () => {
  const slot = new Date("2026-07-07T10:00:00Z");

  it("claims the slot, records when it fired and how it ended, and returns the outcome", async () => {
    const root = await freshRoot();
    const { agent, calls } = recordingAgent();
    const now = () => new Date("2026-07-07T10:00:03Z");
    const outcome = await fireScheduleOnce({ agent, stateRoot: root, schedule: hourly(), slot, now });
    expect(outcome.fired).toBe(true);
    expect(outcome.failed).toBeUndefined();
    expect(calls).toEqual([{ session: scheduleSession("job"), text: "go" }]);
    // ONE file answers both planes: WHEN it fired (where catch-up resumes) and HOW it ended. Its NAME is the slot.
    expect(lastFire(root, "job")).toBe("2026-07-07T10:00:03.000Z");
    expect(claimed(root, "job")).toEqual(["2026-07-07T10-00-00-000Z"]);
    expect(readFires(root, "job")).toMatchObject([{ firedAt: "2026-07-07T10:00:03.000Z", outcome: "completed" }]);
  });

  it("the reply goes to the log, never to disk — rotating it is the platform's job", async () => {
    const root = await freshRoot();
    const logs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    const { agent } = recordingAgent([{ type: "text", delta: "the digest, in full" }, { type: "completed" }]);
    await fireScheduleOnce({ agent, stateRoot: root, schedule: hourly(), slot });
    expect(logs.some((l) => /job completed \(\d+ms\): the digest, in full/.test(l))).toBe(true);
    // Nothing under the state root carries the turn's text: the claim holds an outcome and a duration, and there is
    // no other file. This is the property the whole change exists for — a chatty minute-cron cannot fill a volume.
    const stored = readFires(root, "job");
    expect(stored).toMatchObject([{ outcome: "completed" }]);
    expect(JSON.stringify(stored)).not.toContain("digest");
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

  it("a stale slot is WARNED — a planned run that will never happen must read differently from a retry", async () => {
    // The way in is a wall clock that moved backwards (a VM resume, a host clock correction): `nextRun` keeps
    // producing slots behind the newest claim and the schedule stops firing. No claim is taken, so there is nothing
    // to record an outcome in — the level is the signal: warn here, info for the benign duplicate delivery.
    const root = await freshRoot();
    const logs: { level: string; msg: string }[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      const msg = a.join(" ");
      logs.push({ level: msg.split(" ")[0] ?? "", msg });
    });
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
    expect(logs.some((l) => l.level === "WARN" && /is stale/.test(l.msg))).toBe(true);
    expect(claimed(root, "job")).toEqual(["2026-07-07T12-00-00-000Z"]); // no claim for the stale slot

    // The duplicate path is the ordinary one and stays an info line.
    await fireScheduleOnce({
      agent,
      stateRoot: root,
      schedule: hourly(),
      slot: new Date("2026-07-07T12:00:00.000Z"),
      now: () => new Date("2026-07-07T12:31:00Z"),
    });
    expect(logs.some((l) => l.level === "INFO" && /already claimed/.test(l.msg))).toBe(true);
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

  it("surfaces a failed turn in the outcome and in the claim", async () => {
    const root = await freshRoot();
    const logs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    const { agent } = recordingAgent([{ type: "failed", retryable: false, details: "model exploded" }]);
    const outcome = await fireScheduleOnce({ agent, stateRoot: root, schedule: hourly(), slot });
    expect(outcome.fired).toBe(true);
    expect(outcome.failed).toBe("model exploded");
    expect(readFires(root, "job")[0]).toMatchObject({ outcome: "failed" });
    expect(logs.some((l) => /model exploded/.test(l))).toBe(true); // WHY is a log line, not a stored field
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
