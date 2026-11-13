import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SendRequest } from "../../../src/agent-api.ts";
import { type RunScript, refused, scriptedRun } from "../../doubles/scripted-run.ts";
import { promptOf, scriptedAgent } from "../../doubles/scripted-agent.ts";
import type { Schedule } from "../../../src/schedule/schedule.ts";
import * as Effect from "effect/Effect";
import {
  createScheduler as scheduler,
  fireScheduleOnce as fire,
  scheduleSessions,
} from "../../../src/schedule/scheduler.ts";

const createScheduler = (options: Parameters<typeof scheduler>[0]) => Effect.runSync(scheduler(options));
const fireScheduleOnce = (options: Parameters<typeof fire>[0]) => Effect.runPromise(fire(options));
import { addWakeup, listWakeups } from "../../../src/schedule/wakeups.ts";
import { readFires } from "../../../src/schedule/state.ts";

/** A fake agent that records each invoke's session + text (and the whole request) and answers with the script. */
function recordingAgent(script: RunScript = {}) {
  const calls: { session: string; text: string }[] = [];
  const requests: SendRequest[] = [];
  const agent = scriptedAgent((request) => {
    calls.push({ session: request.sessionId, text: promptOf(request).text });
    requests.push(request);
    return scriptedRun(request, script);
  });
  return { agent, calls, requests };
}

/** The session a schedule continues, as the scheduler recorded it in `root`. */
const scheduleSession = (root: string, name: string): string | undefined => scheduleSessions(root).get(name);

const hourly = (over: Partial<Schedule> = {}): Schedule => ({
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
  it("catches up an overdue run ONCE, claims the slot, in the schedule's own session", async () => {
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
    expect(calls[0]).toEqual({ session: scheduleSession(root, "job"), text: "go" });
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
});

describe("schedule/fireScheduleOnce: the external-clock fire path", () => {
  const slot = new Date("2026-07-07T10:00:00Z");

  it("OVERLAP is `skipped`, not `failed` — the previous turn still running is a policy, not a fault", async () => {
    // A schedule's turns share one `schedule:<name>` session, so an occurrence arriving while the
    // previous one runs is refused by that session. Recording it as `failed` made "the last run was
    // still going" indistinguishable from "the model call died" in `fastagent schedules list`. Every
    // scheduler names this
    // instead: k8s `concurrencyPolicy: Forbid`, Temporal's `Skip` overlap policy.
    const root = await freshRoot();
    const { agent } = recordingAgent(refused("busy"));
    const outcome = await fireScheduleOnce({ agent, stateRoot: root, schedule: hourly(), slot });

    expect(outcome).toMatchObject({ fired: false, skipped: true });
    expect(outcome.failed).toBeUndefined();
    expect(String(outcome.skippedReason)).toContain("still running");
    // The claim STANDS — this occurrence is decided and will not be retried — it just did not fail.
    expect(claimed(root, "job")).toEqual(["2026-07-07T10-00-00-000Z"]);
    expect(readFires(root, "job")).toMatchObject([{ outcome: "skipped" }]);
  });
});
