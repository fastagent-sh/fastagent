/**
 * The agent's own `routines/` go live without a restart (service.ts `liveServingRoutines`, scheduler.ts `reconcile`):
 * the resident clock polls the live list and re-arms exactly what changed, and a changed set is said in one line.
 * The reload policy itself — stamp, TypeScript only, keep-last-good — is `liveCode`'s, tested once in
 * live-tools.test.ts.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { afterEach, expect, it, vi } from "vitest";
import type { Agent } from "../src/agent.ts";
import type { LoadedRoutine } from "../src/schedule/routine.ts";
import { ROUTINE_POLL_MS, createScheduler } from "../src/schedule/scheduler.ts";
import { routineChanges } from "../src/service.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function recordingAgent() {
  const calls: { session: string; text: string }[] = [];
  const agent: Agent = {
    async *invoke(scope, prompt) {
      calls.push({ session: scope.session, text: prompt.text });
      yield { type: "completed" };
    },
  };
  return { agent, calls };
}

const hourly = (over: Partial<LoadedRoutine> = {}): LoadedRoutine => ({
  name: "job",
  cron: "0 * * * *",
  tz: "UTC",
  prompt: "go",
  ...over,
});

/** A resident clock at 10:30 UTC over `boot`, whose live list is whatever `list` holds when it polls. */
async function clock(boot: LoadedRoutine[]) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-07T10:30:00Z"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  const { agent, calls } = recordingAgent();
  const live = { list: boot };
  const scheduler = Effect.runSync(
    createScheduler({
      agent,
      stateRoot: await mkdtemp(join(tmpdir(), "fa-live-routines-")),
      routines: boot,
      read: async () => live.list,
    }),
  );
  scheduler.start();
  return { calls, live, scheduler, poll: () => vi.advanceTimersByTimeAsync(ROUTINE_POLL_MS) };
}

it("a routine written after boot is armed at the next poll, and fires on its cron", async () => {
  const { calls, live, scheduler, poll } = await clock([]);
  live.list = [hourly()];
  await poll();

  await vi.advanceTimersByTimeAsync(30 * 60_000); // → past 11:00
  expect(calls.map((c) => c.text)).toEqual(["go"]);
  scheduler.stop();
});

it("a routine removed after boot is disarmed — its next slot does not fire", async () => {
  const { calls, live, scheduler, poll } = await clock([hourly()]);
  live.list = [];
  await poll();

  await vi.advanceTimersByTimeAsync(30 * 60_000);
  expect(calls).toEqual([]);
  scheduler.stop();
});

it("a re-timed routine fires on its NEW cron only — the old loop is gone", async () => {
  const { calls, live, scheduler, poll } = await clock([hourly()]);
  live.list = [hourly({ cron: "45 * * * *" })];
  await poll();

  await vi.advanceTimersByTimeAsync(15 * 60_000); // 10:30:30 → 10:45:30: the new cron's slot
  expect(calls).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(15 * 60_000); // → 11:00:30: the OLD cron's slot, which must not fire
  expect(calls).toHaveLength(1);
  scheduler.stop();
});

it("an edited prompt is what the next fire says, with no re-arm", async () => {
  const { calls, live, scheduler, poll } = await clock([hourly()]);
  live.list = [hourly({ prompt: "go, differently" })];
  await poll();

  await vi.advanceTimersByTimeAsync(30 * 60_000);
  expect(calls.map((c) => c.text)).toEqual(["go, differently"]);
  scheduler.stop();
});

it("stop() during a poll's read arms nothing when the read lands", async () => {
  // The read and the re-arm are one uninterruptible step, so a stop() that lands while the read is pending does not
  // cancel it: the re-arm runs after stop(), and unguarded it would launch a loop nothing will ever stop.
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-07T10:30:00Z"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  const { agent, calls } = recordingAgent();
  let land: (routines: LoadedRoutine[]) => void = () => {};
  const scheduler = Effect.runSync(
    createScheduler({
      agent,
      stateRoot: await mkdtemp(join(tmpdir(), "fa-live-routines-")),
      routines: [],
      read: () => new Promise((resolve) => (land = resolve)),
    }),
  );
  scheduler.start();
  await vi.advanceTimersByTimeAsync(ROUTINE_POLL_MS); // the poll is now waiting on its read

  scheduler.stop();
  land([hourly()]);
  await vi.advanceTimersByTimeAsync(60 * 60_000);

  expect(calls).toEqual([]);
});

it("the change line names what the agent gave itself — added, re-timed, re-worded, removed", () => {
  const before = [
    hourly({ name: "poll", cron: "0 * * * *", tz: undefined }),
    hourly({ name: "cleanup" }),
    hourly({ name: "brief" }),
  ];
  const after = [
    hourly({ name: "poll", cron: "* * * * *", tz: undefined }),
    hourly({ name: "brief", prompt: "shorter" }),
    { name: "digest", prompt: "sum up" },
  ];

  expect(routineChanges(before, after)).toBe(
    "~ poll (0 * * * * → * * * * *), ~ brief (prompt), + digest (by name), − cleanup",
  );
  expect(routineChanges(after, after)).toBeUndefined();
});
