import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { type Harness, Harness as Harnesses, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import type { ClockStore } from "../../../packages/fastagent/src/schedule/clock.ts";
import { clockStore } from "../../../packages/fastagent/src/harnesses/pi-durable/clock.ts";
import type { SendRequest } from "../../../packages/client/src/agent-api.ts";
import { type RunScript, refused, scriptedRun } from "../../doubles/scripted-run.ts";
import { promptOf, scriptedAgent } from "../../doubles/scripted-agent.ts";
import type { Schedule } from "../../../packages/fastagent/src/schedule/schedule.ts";
import * as Effect from "effect/Effect";
import {
  createScheduler as scheduler,
  fireScheduleNow as fire,
  scheduleSessions,
} from "../../../packages/fastagent/src/schedule/scheduler.ts";

const createScheduler = (options: Parameters<typeof scheduler>[0]) => {
  const created = Effect.runSync(scheduler(options));
  return { ...created, start: () => void created.start() };
};
const fireScheduleNow = (options: Parameters<typeof fire>[0]) => Effect.runPromise(fire(options));
import {
  addWakeup,
  listWakeups,
  removeAnyWakeup,
  takeFirstDueWakeup,
} from "../../../packages/fastagent/src/schedule/wakeups.ts";
import { claimSlot, readFires } from "../../../packages/fastagent/src/schedule/state.ts";

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

/** The session a schedule continues, as the scheduler recorded it. */
const scheduleSession = (root: ClockStore, name: string) => scheduleSessions(root).get(name);

const hourly = (over: Partial<Schedule> = {}): Schedule => ({
  name: "job",
  cron: "0 * * * *", // top of every hour
  tz: "UTC",
  prompt: "go",
  ...over,
});

const opened: Harness[] = [];
/** A clock over an instance's storage of its own, in memory, as a serve keeps one. */
const freshRoot = async (): Promise<ClockStore> => {
  const harness = await Harnesses.open(
    new MemoryStorage(),
    { models: createModels(), registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  opened.push(harness);
  return clockStore(harness, BACKGROUND_CONTEXT);
};

/**
 * Record the claim a fire leaves: stamped with when it was taken — and, unless `settled` is false, the outcome the
 * turn wrote back. An UNSETTLED claim is exactly the shape a killed process leaves behind.
 */
const seedClaim = (root: ClockStore, name: string, firedAt: string, slot = firedAt, settled = true) =>
  root.fires(name, (fires) => ({
    next: [
      ...fires,
      { slot: new Date(slot).toISOString(), firedAt, ...(settled ? { outcome: "completed" as const, ms: 1 } : {}) },
    ],
    result: undefined,
  }));
/** How this clock says the fires for `name` ended. */
const outcomes = async (root: ClockStore, name: string) => (await readFires(root, name)).map((f) => f.outcome);
/** The slots this clock has claimed, oldest first (the decision's own record). */
const claimed = async (root: ClockStore, name: string) => (await readFires(root, name)).map((f) => f.slot);
/** When this clock says the schedule last fired — read the way the scheduler reads it. */
const lastFire = async (root: ClockStore, name: string) => (await readFires(root, name)).at(-1)?.firedAt;

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const harness of opened.splice(0)) await harness.close(BACKGROUND_CONTEXT);
});

describe("schedule/scheduler: fire algorithm", () => {
  it("catches up an overdue run ONCE, claims the slot, in the schedule's own session", async () => {
    const root = await freshRoot();
    await seedClaim(root, "job", "2026-07-07T08:00:00Z"); // last fired 08:00; now is past several hourly slots
    const { agent, calls } = recordingAgent();
    const s = createScheduler({
      agent,
      clock: root,
      schedules: [hourly()],
      now: () => new Date("2026-07-07T12:30:00Z"),
    });
    s.start();
    await vi.waitFor(() => expect(calls.length).toBe(1)); // exactly ONE catch-up, not one per missed slot
    expect(calls[0]).toEqual({ session: await scheduleSession(root, "job"), text: "go" });
    expect(await lastFire(root, "job")).toBe("2026-07-07T12:30:00.000Z"); // the claim records when it fired
    // The same claim records how it ended — no second record, nothing appended anywhere.
    await vi.waitFor(async () => expect(await outcomes(root, "job")).toEqual(["completed", "completed"]));
    s.stop();
  });

  it("fires when the cron instant arrives, then re-arms for the next", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-07T10:30:00Z"));
    const root = await freshRoot();
    const { agent, calls } = recordingAgent();
    const s = createScheduler({ agent, clock: root, schedules: [hourly()] }); // default now = the faked clock
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
    await addWakeup(
      root,
      { session: "conv-9", prompt: "resume", fireAt: new Date("2026-07-07T11:00:00Z") },
      new Date("2026-07-07T10:00:00Z"),
    );
    const { agent, calls } = recordingAgent();
    const s = createScheduler({ agent, clock: root, schedules: [], now: () => new Date("2026-07-07T12:00:00Z") });
    s.start(); // polls wake-ups immediately on start
    await vi.waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]?.session).toBe("conv-9"); // fired back into the wake-up's session
    // The prompt arrives ENVELOPED (id + "not a user message") so the model can tell its own alarm from
    // the user speaking; the instruction itself rides along.
    expect(calls[0]?.text).toMatch(
      /^\[wake-up [0-9a-f-]+ fired — YOUR self-scheduled turn, not a user message\] resume$/,
    );
    expect(await listWakeups(root)).toHaveLength(0); // claimed + fired, not left pending
    s.stop();
  });
});

describe("schedule/claims: the decision to fire", () => {
  it("takes a slot once when two fires race for it, and refuses one behind the newest claim", async () => {
    const root = await freshRoot();
    const slot = new Date("2026-07-07T12:00:00Z");
    const raced = await Promise.all([claimSlot(root, "job", slot, slot), claimSlot(root, "job", slot, slot)]);
    expect(raced.filter(({ taken }) => taken)).toHaveLength(1);
    expect(raced.find(({ taken }) => !taken)).toEqual({ taken: false, why: "duplicate" });
    expect(await claimSlot(root, "job", new Date("2026-07-07T11:00:00Z"), slot)).toEqual({
      taken: false,
      why: "stale",
      newest: slot.toISOString(),
    });
    expect(await claimed(root, "job")).toEqual([slot.toISOString()]);
  });
});

describe("schedule/clock: reading it", () => {
  it("writes nothing: reads, a poll with nothing due and a cancel of a missing wake-up create no document", async () => {
    const storage = new MemoryStorage();
    const harness = await Harnesses.open(
      storage,
      { models: createModels(), registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    opened.push(harness);
    const clock = clockStore(harness, BACKGROUND_CONTEXT);
    expect(await readFires(clock, "job")).toEqual([]);
    expect(await listWakeups(clock)).toEqual([]);
    expect(await takeFirstDueWakeup(clock, new Date("2026-07-07T12:00:00Z"))).toBeUndefined();
    expect(await removeAnyWakeup(clock, "none")).toBeUndefined();
    expect(await scheduleSessions(clock).get("job")).toBeUndefined();
    const session = { kind: "session" } as const;
    for (const address of [
      { kind: "fastagent.schedule-fires", scope: session, key: "job" },
      { kind: "fastagent.wakeups", scope: session },
      { kind: "fastagent.schedule-sessions", scope: session },
    ]) {
      expect(await storage.findDocument(address, "current", BACKGROUND_CONTEXT)).toBeUndefined();
    }
  });
});

describe("schedule/fireScheduleNow: a fire on demand", () => {
  it("OVERLAP is `skipped`, not `failed` — the previous turn still running is a policy, not a fault", async () => {
    // A schedule's turns share one `schedule:<name>` session, so an occurrence arriving while the
    // previous one runs is refused by that session. Recording it as `failed` made "the last run was
    // still going" indistinguishable from "the model call died" in `fastagent schedules list`. Every
    // scheduler names this
    // instead: k8s `concurrencyPolicy: Forbid`, Temporal's `Skip` overlap policy.
    const root = await freshRoot();
    const { agent } = recordingAgent(refused("busy"));
    const outcome = await fireScheduleNow({ agent, clock: root, schedule: hourly() });

    expect(outcome).toMatchObject({ fired: false, skipped: true });
    expect(outcome.failed).toBeUndefined();
    expect(String(outcome.skippedReason)).toContain("still running");
    // The claim STANDS — this occurrence is decided and will not be retried — it just did not fail.
    expect(await claimed(root, "job")).toHaveLength(1);
    expect(await readFires(root, "job")).toMatchObject([{ outcome: "skipped" }]);
  });
});
