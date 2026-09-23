import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, AgentEvent } from "../src/agent.ts";
import type { LoadedRoutine } from "../src/schedule/routine.ts";
import * as Effect from "effect/Effect";
import { createScheduler as scheduler, fireScheduleOnce as fire } from "../src/schedule/scheduler.ts";
import { routineSession } from "../src/schedule/routine.ts";

const createScheduler = (options: Parameters<typeof scheduler>[0]) => Effect.runSync(scheduler(options));
const fireScheduleOnce = (options: Parameters<typeof fire>[0]) => Effect.runPromise(fire(options));
import { MAX_WAKE_ATTEMPTS, addWakeup, listWakeups } from "../src/schedule/wakeups.ts";
import { readFires, settleClaim } from "../src/schedule/state.ts";

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

const hourly = (over: Partial<LoadedRoutine> = {}): LoadedRoutine => ({
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
  writeFileSync(join(dir, file), JSON.stringify(settled ? { firedAt, outcome: "completed", ms: 1 } : { firedAt }));
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
      routines: [hourly()],
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
      routines: [hourly()],
      now: () => new Date("2026-07-07T10:30:00Z"), // 11:00 is still ahead → no catch-up to confuse this
    };
    const s = createScheduler(options);
    s.start();
    expect(readFires(root, "job")).toMatchObject([{ outcome: "interrupted", firedAt: "2026-07-07T10:00:00.000Z" }]);
    // No duration at all: nobody timed this turn, and `0ms` in the history would read as one that took no time.
    expect(readFires(root, "job")[0]).not.toHaveProperty("ms");
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

  it("only the NEWEST unsettled claim is settled interrupted", async () => {
    // A schedule's loop runs one turn at a time, so a killed process leaves exactly one claim unsettled. Walking the
    // whole window would add nothing it can produce — and would rewrite every claim an OLDER FORMAT left without an
    // outcome, turning runs that actually succeeded into `interrupted`.
    const root = await freshRoot();
    vi.spyOn(console, "error").mockImplementation(() => {});
    seedClaim(root, "job", "2026-07-07T08:00:01.000Z", "2026-07-07T08:00:00.000Z"); // a completed fire
    seedClaim(root, "job", "2026-07-07T09:00:00.000Z", undefined, false); // claimed, never settled
    seedClaim(root, "job", "2026-07-07T10:00:00.000Z", undefined, false); // the fire that was actually killed
    const { agent } = recordingAgent();
    const s = createScheduler({
      agent,
      stateRoot: root,
      routines: [hourly()],
      now: () => new Date("2026-07-07T10:30:00Z"),
    });
    s.start();
    expect(outcomes(root, "job")).toEqual(["completed", undefined, "interrupted"]);
    s.stop();
  });

  it("an OLD claim that cannot be read costs the history, not the boot — the newest one is still fatal", async () => {
    // The boot reads one claim, so a file kept only for an operator to look at cannot decide whether a service
    // starts. The newest claim is the opposite: it decides the stale gate and the resume point.
    const root = await freshRoot();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const claims = join(root, "schedule", "claims", "job");
    seedClaim(root, "job", "2026-07-07T09:00:00.000Z");
    mkdirSync(join(claims, "2026-07-07T08-00-00-000Z")); // a DIRECTORY where an old claim goes: EISDIR on read
    const { agent, calls } = recordingAgent();
    const options = {
      agent,
      stateRoot: root,
      routines: [hourly()],
      now: () => new Date("2026-07-07T12:30:00Z"),
    };
    const s = createScheduler(options);
    expect(() => s.start()).not.toThrow();
    await vi.waitFor(() => expect(calls).toHaveLength(1)); // the overdue slot still catches up
    s.stop();

    // …and the same fault on the NEWEST claim stops the boot instead of arming a schedule on a claim nobody read.
    mkdirSync(join(claims, "2026-07-07T13-00-00-000Z"));
    const again = createScheduler(options);
    expect(() => again.start()).toThrow(/EISDIR|illegal operation on a directory/);
    again.stop();
  });

  it("a file that is not a claim is not read as one — it decides nothing and breaks nothing", async () => {
    // A claims directory is a directory, and a foreign name breaks things two ways. `<slot>.tmp` sorts AFTER every
    // real claim, so read as the newest one it would decide whether the next slot is refused as stale, where
    // catch-up resumes, and which fire the reconciler settles. `.DS_Store` (which macOS drops into any directory it
    // opens) sorts before them all and does the other kind of damage: its name cannot be parsed back into a slot,
    // which used to take `start()` down with `RangeError: Invalid time value`.
    const root = await freshRoot();
    vi.spyOn(console, "error").mockImplementation(() => {});
    seedClaim(root, "job", "2026-07-07T08:00:00Z");
    writeFileSync(join(root, "schedule", "claims", "job", ".DS_Store"), "junk");
    writeFileSync(join(root, "schedule", "claims", "job", "2026-07-07T09-00-00-000Z.tmp"), "half a write");
    const { agent, calls } = recordingAgent();
    const s = createScheduler({
      agent,
      stateRoot: root,
      routines: [hourly()],
      now: () => new Date("2026-07-07T12:30:00Z"),
    });
    expect(() => s.start()).not.toThrow();
    // The overdue slot still catches up, and both fires on record are the real ones: neither stray file became a
    // fire, and neither was settled as interrupted.
    await vi.waitFor(() => expect(outcomes(root, "job")).toEqual(["completed", "completed"]));
    expect(calls).toHaveLength(1);
    s.stop();
  });

  it("settling a claim that was pruned mid-turn does not re-create it", async () => {
    // Pruning removed the slot while its turn was still running (512 newer claims during one turn). `settleClaim`
    // WRITES the file it settles, so without the check it would put the pruned slot back — and a resurrected claim
    // is a fire in the history that this state root had already decided to forget.
    const root = await freshRoot();
    const logs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    const slot = new Date("2026-07-07T10:00:00.000Z");
    seedClaim(root, "job", slot.toISOString(), undefined, false);
    rmSync(join(root, "schedule", "claims", "job", "2026-07-07T10-00-00-000Z"));
    settleClaim(root, "job", slot, "completed", 12);
    expect(claimed(root, "job")).toEqual([]);
    expect(readFires(root, "job")).toEqual([]);
    // SILENTLY: a pruned slot is not a fault. Without this, dropping the guard would still leave the file absent
    // (the write would throw and be caught) and the test could not tell the two apart — the warn line is what
    // makes "decided not to write" observably different from "tried and failed".
    expect(logs).toEqual([]);
  });

  it.each([
    [
      "torn mid-write",
      JSON.stringify({ firedAt: "2026-07-07T10:00:00.000Z", outcome: "completed", ms: 12345 }).slice(0, -8),
    ],
    ["an earlier format's bare timestamp", "2026-07-07T10:00:00.000Z"],
    ["JSON that is not a record", "null"],
    ["JSON that is a number", "12"],
  ])(
    "content that is not a claim record (%s) reads as UNSETTLED, never throws, never shouts",
    async (_kind, content) => {
      // The write is deliberately not atomic, so a torn claim is a real state — and `null` parses FINE, so reading it
      // as a record would throw on the synchronous boot path: a service that does not start, over one unreadable file.
      // Every one of these degrades the same way, to the slot instant in the file NAME.
      const root = await freshRoot();
      const warns: string[] = [];
      vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void warns.push(a.join(" ")));
      const dir = join(root, "schedule", "claims", "job");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "2026-07-07T10-00-00-000Z"), content);
      const fire = readFires(root, "job")[0];
      expect(fire).toMatchObject({ firedAt: "2026-07-07T10:00:00.000Z" });
      expect(fire).not.toHaveProperty("outcome"); // so the next boot settles it as interrupted, which is true
      expect(fire).not.toHaveProperty("ms");
      // And quietly: with no migration every one of the 512 retained claims can be the old format, and a wall of
      // warnings reads like corruption. The consequence is already visible — each of these rows prints `unreported`.
      expect(warns).toEqual([]);
    },
  );

  it("a duration that is not a number reads as NO duration, never as 0ms", async () => {
    // `0` would print as a turn that really did finish instantly, which is the one value this record will not
    // invent — the same rule an untimed fire follows.
    const root = await freshRoot();
    const dir = join(root, "schedule", "claims", "job");
    mkdirSync(dir, { recursive: true });
    const raw = JSON.stringify({ firedAt: "2026-07-07T10:00:00.000Z", outcome: "completed", ms: "12x45" });
    writeFileSync(join(dir, "2026-07-07T10-00-00-000Z"), raw);
    expect(readFires(root, "job")[0]).toMatchObject({ outcome: "completed" });
    expect(readFires(root, "job")[0]).not.toHaveProperty("ms");
  });

  it("re-settling a claim leaves no tail of the longer record it replaced", async () => {
    // A shorter record written over a longer one would otherwise leave the old tail behind; with JSON that tail can
    // only break the parse, but a file that says one thing is still worth having.
    const root = await freshRoot();
    const slot = new Date("2026-07-07T10:00:00.000Z");
    seedClaim(root, "job", slot.toISOString(), undefined, false);
    settleClaim(root, "job", slot, "completed", 12345);
    expect(readFires(root, "job")[0]).toMatchObject({ outcome: "completed", ms: 12345 });
    settleClaim(root, "job", slot, "interrupted");
    expect(readFires(root, "job")[0]).toMatchObject({ outcome: "interrupted" });
    expect(readFires(root, "job")[0]).not.toHaveProperty("ms");
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

  it("catches up an overdue run ONCE, claims the slot, session = routine:<name>", async () => {
    const root = await freshRoot();
    seedClaim(root, "job", "2026-07-07T08:00:00Z"); // last fired 08:00; now is past several hourly slots
    const { agent, calls } = recordingAgent();
    const s = createScheduler({
      agent,
      stateRoot: root,
      routines: [hourly()],
      now: () => new Date("2026-07-07T12:30:00Z"),
    });
    s.start();
    await vi.waitFor(() => expect(calls.length).toBe(1)); // exactly ONE catch-up, not one per missed slot
    expect(calls[0]).toEqual({ session: routineSession("job"), text: "go" });
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
    const s = createScheduler({ agent, stateRoot: root, routines: [hourly()] }); // default now = the faked clock
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
    const s = createScheduler({ agent, stateRoot: root, routines: [hourly()] });
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
    const s = createScheduler({ agent, stateRoot: root, routines: [], now: () => new Date("2026-07-07T12:00:00Z") });
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

  it("a wake-up's ANSWER stays in its conversation — the log gets the outcome, not the reply", async () => {
    // The opposite case from a cron fire: this turn runs in the session that scheduled it, where humans read the
    // answer. Logging it would copy a private exchange into the operator's log stream for no diagnostic gain.
    const root = await freshRoot();
    addWakeup(
      root,
      { session: "conv-9", prompt: "resume", fireAt: new Date("2026-07-07T11:00:00Z") },
      new Date("2026-07-07T10:00:00Z"),
    );
    const logs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    const { agent, calls } = recordingAgent([
      { type: "text", delta: "your bank balance is 12345" },
      { type: "completed" },
    ]);
    const s = createScheduler({ agent, stateRoot: root, routines: [], now: () => new Date("2026-07-07T12:00:00Z") });
    s.start();
    await vi.waitFor(() => expect(calls.length).toBe(1));
    await vi.waitFor(() => expect(logs.some((l) => /wake \w+ completed \(\d+ms\)/.test(l))).toBe(true));
    expect(logs.join("\n")).not.toContain("bank balance");
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
    const s = createScheduler({ agent, stateRoot: root, routines: [], now: () => new Date("2026-07-07T12:00:00Z") });
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
    const s = createScheduler({ agent, stateRoot: root, routines: [], now: () => new Date("2026-07-07T12:00:00Z") });
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
      routines: [hourly()],
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
    const s = createScheduler({ agent, stateRoot: root, routines: [], now: () => new Date("2026-07-07T09:00:30Z") });
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
    // Every level goes through console.error (log.ts); the LEVEL is in the formatted line.
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    const { agent, calls } = recordingAgent([
      { type: "failed", retryable: true, code: "session_busy", details: "busy" },
    ]);
    const s = createScheduler({ agent, stateRoot: root, routines: [], now: () => new Date("2026-07-07T10:00:00Z") });
    s.start();
    await vi.waitFor(() => expect(calls.length).toBe(1));
    // The recurrence survives (the CLAIM advanced it in place); THIS occurrence is reported skipped, never deferred
    // — a recurring has a next occurrence by definition.
    expect(listWakeups(root)).toHaveLength(1);
    expect(listWakeups(root)[0]).toMatchObject({ id: "rec2", fireAt: "2026-07-08T09:00:00.000Z" });
    await vi.waitFor(() => expect(logs.some((l) => /INFO.*occurrence skipped \(session busy\)/.test(l))).toBe(true));
    expect(logs.join("\n")).not.toMatch(/ERROR/); // a busy recurring occurrence is a policy outcome, not a fault
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
    const s = createScheduler({ agent, stateRoot: root, routines: [], now: () => new Date("2026-07-07T12:00:00Z") });
    s.start();
    await vi.waitFor(() => expect(calls.length).toBe(1));
    await vi.waitFor(() => expect(logs.some((l) => /dropped after too many/.test(l))).toBe(true));
    expect(listWakeups(root)).toHaveLength(0); // gone — that's exactly why the drop must be reported as an error
    s.stop();
  });
});

describe("schedule/createScheduler: a routine with no cron", () => {
  it("is not armed, and not warned about either", async () => {
    // A routine without a cron is reached by NAME, so there is nothing for the clock to arm. The
    // absence must not read as "a cron that will never fire again" — that warning exists for a real
    // cron whose grid has run out, and firing it here would send an operator after nothing.
    const root = await freshRoot();
    const logs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    const { agent, calls } = recordingAgent();
    const onDemand = { name: "reindex", prompt: "refresh" } as LoadedRoutine;
    const s = createScheduler({
      agent,
      stateRoot: root,
      routines: [onDemand],
      now: () => new Date("2026-07-07T10:30:00Z"),
    });
    s.start();
    await new Promise((r) => setTimeout(r, 50));
    s.stop();

    expect(calls).toEqual([]); // nothing fired it
    expect(logs.join("\n")).not.toMatch(/will never fire again/);
    expect(claimed(root, "reindex")).toEqual([]); // and nothing was claimed
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
    expect(calls).toEqual([{ session: routineSession("job"), text: "go" }]);
    // ONE file answers both planes: WHEN it fired (where catch-up resumes) and HOW it ended. Its NAME is the slot.
    expect(lastFire(root, "job")).toBe("2026-07-07T10:00:03.000Z");
    expect(claimed(root, "job")).toEqual(["2026-07-07T10-00-00-000Z"]);
    expect(readFires(root, "job")).toMatchObject([{ firedAt: "2026-07-07T10:00:03.000Z", outcome: "completed" }]);
  });

  it("OVERLAP is `skipped`, not `failed` — the previous turn still running is a policy, not a fault", async () => {
    // A schedule's turns share one `routine:<name>` session, so an occurrence arriving while the
    // previous one runs is refused by that session. Recording it as `failed` made "the last run was
    // still going" indistinguishable from "the model call died" in `fastagent routine history`, and
    // handed a public `POST /run` caller a `failed` that is not one. Every scheduler names this
    // instead: k8s `concurrencyPolicy: Forbid`, Temporal's `Skip` overlap policy.
    const root = await freshRoot();
    const { agent } = recordingAgent([{ type: "failed", retryable: true, code: "session_busy", details: "busy" }]);
    const outcome = await fireScheduleOnce({ agent, stateRoot: root, schedule: hourly(), slot });

    expect(outcome).toMatchObject({ fired: false, skipped: true });
    expect(outcome.failed).toBeUndefined();
    expect(String(outcome.skippedReason)).toContain("still running");
    // The claim STANDS — this occurrence is decided and will not be retried — it just did not fail.
    expect(claimed(root, "job")).toEqual(["2026-07-07T10-00-00-000Z"]);
    expect(readFires(root, "job")).toMatchObject([{ outcome: "skipped" }]);
  });

  it("…and the LOG says so too — the line an operator reads first is not an error", async () => {
    // The claim file said `skipped` and the reply said `skipped: true`, while `docker logs` /
    // CloudWatch still printed `ERROR [schedule] job failed (1ms): busy`. That line is the first place
    // anyone looks, so until it changed, the distinction this outcome exists for did not exist where
    // it is used. `failed` rides along on a busy rejection only because that is the SPEC's one
    // terminal event shape — a wire detail, not a verdict.
    const root = await freshRoot();
    const lines: string[] = [];
    // Every level goes through console.error (log.ts); the LEVEL is in the formatted line, which is
    // exactly what this asserts.
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    const { agent } = recordingAgent([{ type: "failed", retryable: true, code: "session_busy", details: "busy" }]);
    await fireScheduleOnce({ agent, stateRoot: root, schedule: hourly(), slot });

    expect(lines.join("\n")).toMatch(/INFO.*job: occurrence skipped \(session busy\)/);
    expect(lines.join("\n")).not.toMatch(/ERROR/);
    expect(lines.join("\n")).not.toMatch(/failed/);
  });

  it("a turn that really fails is `failed`, and its occurrence is spent either way", async () => {
    // The boundary this pair draws. The claim is the DECISION, so a failed turn is not retried: an
    // agent turn has external side effects (a message sent, a file written) and nothing here can tell
    // a failure before them from one after. The engine's own retry budget is what covers a transient
    // model error; by the time a `failed` event arrives, that budget is spent.
    const root = await freshRoot();
    const { agent } = recordingAgent([{ type: "failed", retryable: false, details: "upstream 500" }]);
    const outcome = await fireScheduleOnce({ agent, stateRoot: root, schedule: hourly(), slot });

    expect(outcome).toMatchObject({ fired: true, failed: "upstream 500" });
    expect(outcome.skipped).toBeUndefined();
    expect(readFires(root, "job")).toMatchObject([{ outcome: "failed" }]);
  });

  it("what the turn SAID is neither logged nor stored — it is already in the session", async () => {
    // #546 asked us to stop storing model output that nothing prunes. The reply is durable exactly once, in the
    // session this fire ran in (`routine:job`, persisted under `<stateRoot>/sessions/` like any other): the claim
    // carries the outcome, and the log carries the fact that it completed.
    const root = await freshRoot();
    const logs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    const { agent } = recordingAgent([{ type: "text", delta: "the digest, in full" }, { type: "completed" }]);
    await fireScheduleOnce({ agent, stateRoot: root, schedule: hourly(), slot });
    expect(logs.some((l) => /job completed \(\d+ms\)$/.test(l))).toBe(true);
    expect(logs.join("\n")).not.toContain("digest");
    const stored = readFires(root, "job");
    expect(stored).toMatchObject([{ outcome: "completed" }]);
    expect(JSON.stringify(stored)).not.toContain("digest");
  });

  it("a multi-line failure detail stays ONE line — a turn cannot forge a log record", async () => {
    // `log.ts` prefixes only the first line, so an unfolded newline emits a second line byte-for-byte identical to a
    // real record. A failure detail is the remaining path that carries model or provider text.
    const root = await freshRoot();
    const logs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    const forged = "boom\n  at somewhere\nERROR [schedule] daily failed (1ms): DISK ON FIRE";
    const { agent } = recordingAgent([{ type: "failed", retryable: false, details: forged }]);
    await fireScheduleOnce({ agent, stateRoot: root, schedule: hourly(), slot });
    const line = logs.find((l) => /job failed/.test(l)) ?? "";
    expect(line).not.toContain("\n");
    expect(line).toContain("boom at somewhere ERROR [schedule] daily failed (1ms): DISK ON FIRE"); // folded, not cut
    expect(logs.filter((l) => /^ERROR \[schedule\] daily/.test(l))).toEqual([]); // nothing became its own record
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
      routines: [hourly()],
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

describe("schedule/scheduler: wake-ups need self-scheduling", () => {
  it("with wake-ups off, one left in the store does not fire — its unwake tool is not mounted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-07T10:30:00Z"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const root = await freshRoot();
    const added = addWakeup(root, { session: "chat", prompt: "check again", cron: "*/15 * * * *" });
    expect(added.ok).toBe(true);
    const { agent, calls } = recordingAgent();
    // A routine keeps the scheduler running, which is how the wake-up poll ran with self-scheduling off.
    const s = createScheduler({ agent, stateRoot: root, routines: [hourly()], wakeups: false });
    s.start();

    await vi.advanceTimersByTimeAsync(60 * 60_000);

    expect(calls.map((c) => c.session)).toEqual(["routine:job"]); // the 11:00 routine, and no wake-up
    s.stop();
  });
});
