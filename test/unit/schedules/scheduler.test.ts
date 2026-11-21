import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { type Harness, Harness as Harnesses, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { cronError, nextRun } from "../../../packages/fastagent/src/schedule/cron.ts";
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
  it("writes nothing: read-only clock queries create no document", async () => {
    const storage = new MemoryStorage();
    const harness = await Harnesses.open(
      storage,
      { models: createModels(), registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    opened.push(harness);
    const clock = clockStore(harness, BACKGROUND_CONTEXT);
    expect(await readFires(clock, "job")).toEqual([]);
    expect(await scheduleSessions(clock).get("job")).toBeUndefined();
    const session = { kind: "session" } as const;
    for (const address of [
      { kind: "fastagent.schedule-fires", scope: session, key: "job" },
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

describe("schedule/scheduler: scale-to-zero arming, tick and nextDue", () => {
  it("catches up a schedule's very first slot when the machine stopped after arming and reopened past the slot", async () => {
    const root = await freshRoot();
    const { agent: firstAgent, calls: firstCalls } = recordingAgent();
    // Opened at 10:30 before the 11:00 hourly slot, then stopped while idle at 10:45.
    const first = Effect.runSync(
      scheduler({ agent: firstAgent, clock: root, schedules: [hourly()], now: () => new Date("2026-07-07T10:30:00Z") }),
    );
    await first.start();
    expect(firstCalls).toHaveLength(0);
    expect((await first.nextDue(new Date("2026-07-07T10:30:00Z")))?.toISOString()).toBe("2026-07-07T11:00:00.000Z");
    first.stop();

    // Woken by an external alarm 4 seconds past 11:00: `armed` remembers 10:30, so 11:00 catches up instead of
    // skipping to 12:00, and `nextDue` moves to 12:00 as soon as `start` resolves.
    const { agent: secondAgent, calls: secondCalls } = recordingAgent();
    const second = Effect.runSync(
      scheduler({
        agent: secondAgent,
        clock: root,
        schedules: [hourly()],
        now: () => new Date("2026-07-07T11:00:04Z"),
      }),
    );
    await second.start();
    expect(secondCalls).toHaveLength(1);
    expect(await claimed(root, "job")).toEqual(["2026-07-07T11:00:00.000Z"]);
    expect((await second.nextDue(new Date("2026-07-07T11:00:04Z")))?.toISOString()).toBe("2026-07-07T12:00:00.000Z");
    second.stop();
  });

  it("tick drains schedules stamped with `since`, and nextDue advances to the next slot", async () => {
    const root = await freshRoot();
    const { agent, calls } = recordingAgent();
    const s = Effect.runSync(
      scheduler({ agent, clock: root, schedules: [hourly()], now: () => new Date("2026-07-07T11:00:05Z") }),
    );
    await s.tick({ since: new Date("2026-07-07T10:40:00Z") });
    expect(calls).toHaveLength(1);
    expect((await s.nextDue(new Date("2026-07-07T11:00:05Z")))?.toISOString()).toBe("2026-07-07T12:00:00.000Z");
    s.stop();
  });
});

describe("schedule/cron", () => {
  it("nextRun is the next instant STRICTLY AFTER `from`, timezone-aware, UTC by default", () => {
    // 9am America/New_York = 13:00 UTC in July (EDT).
    const n = nextRun("0 9 * * *", "America/New_York", new Date("2026-07-07T00:00:00Z"));
    expect(n?.toISOString()).toBe("2026-07-07T13:00:00.000Z");
    // From that instant, the NEXT one is the following day (strictly after, not the same slot).
    expect(nextRun("0 9 * * *", "America/New_York", n!)?.toISOString()).toBe("2026-07-08T13:00:00.000Z");
    // Omitted tz is UTC, not the host's zone.
    expect(nextRun("0 9 * * *", undefined, new Date("2026-07-07T00:00:00Z"))?.toISOString()).toBe(
      "2026-07-07T09:00:00.000Z",
    );
  });

  it("cronError: undefined for valid, a message for an invalid pattern or timezone", () => {
    expect(cronError("0 9 * * *", "UTC")).toBeUndefined();
    expect(cronError("not a cron", undefined)).toBeTruthy();
    expect(cronError("0 9 * * *", "Not/AZone")).toBeTruthy();
  });
});
