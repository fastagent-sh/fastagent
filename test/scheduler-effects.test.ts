import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as TestClock from "effect/testing/TestClock";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, expectTypeOf, it, vi } from "vitest";
import type { Agent, AgentEvent } from "../src/agent.ts";
import { activeWork } from "../src/channels/busy.ts";
import type { PortFailure } from "../src/effect-port.ts";
import {
  createScheduler,
  fireScheduleOnce,
  type ScheduleFireOutcome,
  type Scheduler,
} from "../src/schedule/scheduler.ts";
import { readFires, scheduleFile, writeScheduleFile } from "../src/schedule/state.ts";
import { listWakeups } from "../src/schedule/wakeups.ts";
import { log } from "../src/log.ts";

const NOW = new Date("2026-07-07T10:30:00Z");
const hourly = (name = "job") => ({ name, cron: "0 * * * *", tz: "UTC", prompt: "go" });
const freshRoot = () => mkdtemp(join(tmpdir(), "fa-scheduler-effects-"));
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
/**
 * Seed a HEALTHY prior fire: the slot's claim, stamped with when it was taken AND with the outcome the turn wrote
 * back. Without the outcome the boot reconciler would report the claim as `interrupted`, which is a different test.
 */
function seedFiredSlots(stateRoot: string, names: string[], firedAt: string, slot = firedAt): void {
  for (const name of names) {
    const dir = join(stateRoot, "schedule", "claims", name);
    mkdirSync(dir, { recursive: true });
    // Through `toISOString` first: a claim file name is the shape `claimSlot` writes, and nothing else is read as one.
    const record = JSON.stringify({ firedAt, outcome: "completed", ms: 1 });
    writeFileSync(join(dir, new Date(slot).toISOString().replace(/[:.]/g, "-")), record);
  }
}
/** How this state root says each fire of `name` ended — `undefined` = claimed, never settled. */
const outcomes = (stateRoot: string, name = "job"): (string | undefined)[] =>
  readFires(stateRoot, name).map((f) => f.outcome);
/** When a state root says this schedule last fired — the claim, read the way the scheduler reads it. */
const lastFire = (stateRoot: string, name: string): string | undefined => readFires(stateRoot, name).at(-1)?.firedAt;

afterEach(() => vi.restoreAllMocks());

it("two SCHEDULERS over one state root fire a cron slot exactly once", async () => {
  // The reason this claim is atomic: `fires.json` was a read-modify-write, which two processes both won. Two
  // schedulers exist whenever a restart overlaps its predecessor, someone runs a second `start` on one directory, or
  // an external clock delivers while the resident one is armed — and a double fire is a real turn, billed twice.
  const stateRoot = await freshRoot();
  const source = new URL("../src/schedule/scheduler.ts", import.meta.url).href;
  const slot = "2026-07-07T10:00:00.000Z";
  const fire = (): Promise<string> =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
          import * as Effect from "effect/Effect";
          const { fireScheduleOnce } = await import(${JSON.stringify(source)});
          const agent = { async *invoke() { await new Promise((r) => setTimeout(r, 150)); yield { type: "completed" }; } };
          const outcome = await Effect.runPromise(fireScheduleOnce({
            agent,
            stateRoot: ${JSON.stringify(stateRoot)},
            schedule: { name: "job", cron: "0 * * * *", tz: "UTC", prompt: "go" },
            slot: new Date(${JSON.stringify(slot)}),
          }));
          process.send(outcome.fired ? "fired" : "skipped");
          `,
        ],
        { stdio: ["ignore", "ignore", "inherit", "ipc"] },
      );
      child.on("message", (value) => resolve(String(value)));
      child.on("exit", (code) => reject(new Error(`child exited without an outcome (${code})`)));
    });

  const fired = await Promise.all([fire(), fire(), fire()]);
  expect(fired.filter((o) => o === "fired")).toHaveLength(1);
  expect(fired.filter((o) => o === "skipped")).toHaveLength(2);
  expect(outcomes(stateRoot)).toEqual(["completed"]); // one settled claim, so one billed turn
});

it.each(["cron", "one-shot", "recurring"] as const)(
  "SIGTERM preserves the claimed %s state without claiming the next wake",
  async (kind) => {
    const stateRoot = await freshRoot();
    const schedules = kind === "cron" ? [hourly()] : [];
    if (kind === "cron") seedFiredSlots(stateRoot, ["job"], "2026-07-07T08:00:00Z");
    else
      writeScheduleFile(scheduleFile(stateRoot, "wakeups"), [
        {
          id: "first",
          session: "first",
          prompt: "go",
          fireAt: "2026-07-07T09:00:00Z",
          ...(kind === "recurring" ? { cron: "0 * * * *", tz: "UTC" } : {}),
        },
        { id: "next", session: "next", prompt: "later", fireAt: "2026-07-07T09:00:00Z" },
      ]);
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import * as Effect from "effect/Effect";
    const { createScheduler } = await import(process.argv[1]);
    const { stateRoot, schedules, now } = JSON.parse(process.argv[2]);
    process.on("message", () => {});
    const agent = { async *invoke() { process.send("running"); await new Promise(() => {}); } };
    Effect.runSync(createScheduler({ agent, stateRoot, schedules, now: () => new Date(now) })).start();
  `,
        new URL("../src/schedule/scheduler.ts", import.meta.url).href,
        JSON.stringify({ stateRoot, schedules, now: NOW.toISOString() }),
      ],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    let stderr = "";
    child.stderr?.on("data", (data) => {
      stderr += data;
    });
    const exited = once(child, "exit");
    try {
      expect(
        await Promise.race([
          once(child, "message").then(([value]) => value),
          exited.then(() => {
            throw new Error(`child exited before running: ${stderr}`);
          }),
        ]),
      ).toBe("running");
    } finally {
      child.kill("SIGTERM");
      await exited;
    }
    // The killed turn wrote no outcome; its claim is simply unsettled, next to the seeded prior fire.
    expect(outcomes(stateRoot)).toEqual(kind === "cron" ? ["completed", undefined] : []);
    if (kind === "cron") expect(lastFire(stateRoot, "job")).toBe(NOW.toISOString());
    else {
      expect(listWakeups(stateRoot).map((w) => w.id)).toEqual(kind === "recurring" ? ["first", "next"] : ["next"]);
      if (kind === "recurring") expect(listWakeups(stateRoot)[0]?.fireAt).toBe("2026-07-07T11:00:00.000Z");
    }
    const calls: string[] = [];
    const s = Effect.runSync(
      createScheduler({
        agent: {
          async *invoke(scope) {
            calls.push(scope.session);
            yield { type: "completed" };
          },
        },
        stateRoot,
        schedules,
        now: () => NOW,
      }),
    );
    try {
      s.start();
      await tick();
      expect(calls).toEqual(kind === "cron" ? [] : ["next"]);
      // The claim the killed process left is not replayed, and this boot puts it on the record. A wake-up has no
      // such claim to reconcile — it leaves the store before its turn starts, so the killed occurrence is simply
      // gone (`next` above is the SECOND wake-up, not a replay of the killed one).
      expect(outcomes(stateRoot)).toEqual(kind === "cron" ? ["completed", "interrupted"] : []);
      if (kind === "cron") {
        expect(readFires(stateRoot, "job").at(-1)).toMatchObject({
          outcome: "interrupted",
          firedAt: NOW.toISOString(),
        });
      }
    } finally {
      s.stop();
    }
  },
);

it("uses the provided clock across start and stop, without counting idle timers as work", async () => {
  const stateRoot = await freshRoot();
  const calls: string[] = [];
  const agent: Agent = {
    async *invoke(scope) {
      calls.push(scope.session);
      yield { type: "completed" };
    },
  };
  const base = activeWork();
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW.getTime());
      const s = yield* createScheduler({ agent, stateRoot, schedules: [hourly()] });
      try {
        s.start();
        yield* TestClock.adjust(29 * 60_000);
        expect(calls).toEqual([]);
        expect(activeWork()).toBe(base);
        yield* TestClock.adjust(60_000);
        expect(calls).toEqual(["schedule:job"]);
        expect(readFires(stateRoot, "job")[0]).toMatchObject({
          firedAt: "2026-07-07T11:00:00.000Z",
          outcome: "completed",
          ms: 0,
        });
        s.stop();
        yield* TestClock.adjust(2 * 60 * 60_000);
        expect(calls).toHaveLength(1);
        expect(activeWork()).toBe(base);
      } finally {
        s.stop();
      }
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

it("keeps schedules concurrent, serializes each schedule, and skips slots missed by a slow turn", async () => {
  const stateRoot = await freshRoot();
  const finish = Promise.withResolvers<void>();
  const calls: string[] = [];
  const agent: Agent = {
    async *invoke(scope) {
      calls.push(scope.session);
      await finish.promise;
      yield { type: "completed" };
    },
  };
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW.getTime());
      const s = yield* createScheduler({ agent, stateRoot, schedules: [hourly("a"), hourly("b")] });
      try {
        s.start();
        yield* TestClock.adjust(2 * 60 * 60_000);
        expect(calls).toEqual(["schedule:a", "schedule:b"]);
        finish.resolve();
        yield* Effect.promise(tick);
        yield* TestClock.adjust(29 * 60_000);
        expect(calls).toHaveLength(2);
        yield* TestClock.adjust(60_000);
        expect(calls).toEqual(["schedule:a", "schedule:b", "schedule:a", "schedule:b"]);
      } finally {
        s.stop();
        finish.resolve();
      }
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

it("rechecks capped waits against wall-clock jumps and never fires early", async () => {
  const stateRoot = await freshRoot();
  let wall = new Date("2026-07-07T10:30:00Z");
  const invoke = vi.fn(async function* (): AsyncIterable<AgentEvent> {
    yield { type: "completed" };
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      const s = yield* createScheduler({
        agent: { invoke },
        stateRoot,
        schedules: [{ ...hourly(), cron: "0 9 * * *" }],
        now: () => wall,
      });
      try {
        s.start();
        wall = new Date("2026-07-06T10:30:00Z");
        yield* TestClock.adjust(6 * 60 * 60_000);
        expect(invoke).not.toHaveBeenCalled();
        wall = new Date("2026-07-09T10:30:00Z");
        yield* TestClock.adjust(6 * 60 * 60_000);
        expect(invoke).toHaveBeenCalledOnce();
        expect(lastFire(stateRoot, "job")).toBe(wall.toISOString());
      } finally {
        s.stop();
      }
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

it("publishes the running loop before an invoke callback re-enters stop", async () => {
  const stateRoot = await freshRoot();
  seedFiredSlots(stateRoot, ["a", "b"], "2026-07-07T08:00:00Z");
  let s: Scheduler;
  const invoke = vi.fn(() => {
    s.stop();
    return (async function* (): AsyncIterable<AgentEvent> {
      yield { type: "completed" };
    })();
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW.getTime());
      s = yield* createScheduler({ agent: { invoke }, stateRoot, schedules: [hourly("a"), hourly("b")] });
      try {
        s.start();
        yield* Effect.promise(tick);
        yield* TestClock.adjust(2 * 60 * 60_000);
        expect(invoke).toHaveBeenCalledOnce();
        expect(outcomes(stateRoot, "a")).toEqual(["completed", "completed"]); // the seeded prior fire, then this one
        expect(lastFire(stateRoot, "b")).toBe("2026-07-07T08:00:00Z");
      } finally {
        s.stop();
      }
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

it("reports a defective wake clock instead of silently losing its polling loop", async () => {
  const stateRoot = await freshRoot();
  const error = new Error("clock failed");
  const logged = vi.spyOn(log, "error").mockImplementation(() => {});
  await Effect.runPromise(
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      vi.spyOn(clock, "sleep").mockReturnValue(Effect.die(error));
      const s = yield* createScheduler({ agent: { invoke: vi.fn() }, stateRoot, schedules: [] });
      s.start();
      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining("wake-up poll: stopped unexpectedly: Error: clock failed"),
      );
      s.stop();
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

it("an iterator throw stays terminal, with or without a preceding busy event", async () => {
  for (const busy of [false, true]) {
    const stateRoot = await freshRoot();
    const error = new Error("iterator failed", { cause: { payload: "private-provider-data" } });
    const logged = vi.spyOn(log, "error").mockImplementation(() => {});
    const invoke = vi.fn(async function* (): AsyncIterable<AgentEvent> {
      if (busy) yield { type: "failed", code: "session_busy", retryable: true, details: "busy" };
      throw error;
    });
    writeScheduleFile(scheduleFile(stateRoot, "wakeups"), [
      { id: "w", session: "s", prompt: "go", fireAt: "2026-07-07T09:00:00Z" },
    ]);
    const s = Effect.runSync(createScheduler({ agent: { invoke }, stateRoot, schedules: [], now: () => NOW }));
    try {
      s.start();
      const label = `busy=${busy}`;
      // A wake-up has no claim to settle, so the log line IS the record of the failure.
      await vi.waitFor(() => expect(logged.mock.calls.flat().join(" "), label).toContain("Error: iterator failed"));
      expect(listWakeups(stateRoot), label).toEqual([]);
      expect(invoke, label).toHaveBeenCalledOnce();
      expect(logged.mock.calls.flat().join(" "), label).not.toContain("private-provider-data");
    } finally {
      s.stop();
    }
  }
});

it.each([false, true])("reports a wake deferral write failure before restoring stop (stopped=%s)", async (stopped) => {
  const stateRoot = await freshRoot();
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const errors = vi.spyOn(log, "error").mockImplementation(() => {});
  const calls: string[] = [];
  const agent: Agent = {
    async *invoke(scope) {
      calls.push(scope.session);
      if (scope.session === "busy") {
        entered.resolve();
        await finish.promise;
        yield { type: "failed", code: "session_busy", retryable: true, details: "busy" };
      } else yield { type: "completed" };
    },
  };
  const path = scheduleFile(stateRoot, "wakeups");
  writeScheduleFile(path, [
    { id: "first", session: "busy", prompt: "go", fireAt: NOW.toISOString() },
    { id: "next", session: "next", prompt: "later", fireAt: NOW.toISOString() },
  ]);
  const base = activeWork();
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW.getTime());
      const s = yield* createScheduler({ agent, stateRoot, schedules: [] });
      try {
        s.start();
        yield* Effect.promise(() => entered.promise);
        yield* Effect.promise(() => mkdir(`${path}.tmp`));
        if (stopped) s.stop();
        expect(activeWork()).toBe(base + 1);
        finish.resolve();
        yield* Effect.promise(() =>
          vi.waitFor(() =>
            expect(errors).toHaveBeenCalledWith(
              expect.stringMatching(/wake-up poll failed.*EISDIR.*wakeups\.json\.tmp/),
            ),
          ),
        );
        expect(activeWork()).toBe(base);
        expect(calls).toEqual(["busy"]);
        expect(listWakeups(stateRoot).map((w) => w.id)).toEqual(["next"]);
        yield* Effect.promise(() => rm(`${path}.tmp`, { recursive: true }));
        yield* TestClock.adjust(30_000);
        expect(calls).toEqual(stopped ? ["busy"] : ["busy", "next"]);
        expect(listWakeups(stateRoot).map((w) => w.id)).toEqual(stopped ? ["next"] : []);
        expect(errors.mock.calls.filter(([message]) => message.includes("wake-up poll failed"))).toHaveLength(1);
      } finally {
        s.stop();
        finish.resolve();
      }
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

it("keeps claim IO failures typed and never invokes, and never burns the slot", async () => {
  const stateRoot = await freshRoot();
  // A FILE where `claims/job/` belongs: `claimSlot` throws ENOTDIR, and it throws BEFORE creating the claim — so the
  // slot is still there to run once the fault is fixed, which is the whole reason the claim is the only state write.
  await mkdir(join(stateRoot, "schedule", "claims"), { recursive: true });
  await writeFile(join(stateRoot, "schedule", "claims", "job"), "");
  const invoke = vi.fn();
  const work = fireScheduleOnce({ agent: { invoke }, stateRoot, schedule: hourly(), slot: NOW });
  expectTypeOf(work).toEqualTypeOf<Effect.Effect<ScheduleFireOutcome, PortFailure>>();
  // @ts-expect-error -- a failed durable claim still needs a failure policy
  const infallible: Effect.Effect<ScheduleFireOutcome> = work;
  void infallible;
  const exit = await Effect.runPromiseExit(work);
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit))
    expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "PortFailure", cause: expect.any(Error) });
  expect(invoke).not.toHaveBeenCalled();

  // The fault is fixed and the SAME slot still fires: a failed state write must not consume it.
  await rm(join(stateRoot, "schedule", "claims", "job"));
  const retry = await Effect.runPromise(
    fireScheduleOnce({
      agent: {
        async *invoke() {
          yield { type: "completed" as const };
        },
      },
      stateRoot,
      schedule: hourly(),
      slot: NOW,
    }),
  );
  expect(retry).toMatchObject({ fired: true });
  expect(outcomes(stateRoot)).toEqual(["completed"]); // the recovered slot is the only fire on record
});

it("a boot-time cron-state fault fails start synchronously before any loop runs", async () => {
  const stateRoot = await freshRoot();
  await mkdir(join(stateRoot, "schedule", "claims"), { recursive: true });
  await writeFile(join(stateRoot, "schedule", "claims", "job"), "");
  const invoke = vi.fn();
  const s = Effect.runSync(createScheduler({ agent: { invoke }, stateRoot, schedules: [hourly()] }));
  expect(() => s.start()).toThrow(/ENOTDIR|not a directory/);
  s.stop();
  await tick();
  expect(invoke).not.toHaveBeenCalled();
});

it("an interrupted external fire joins its claimed turn and its settlement", async () => {
  const stateRoot = await freshRoot();
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const abort = new AbortController();
  const agent: Agent = {
    async *invoke() {
      entered.resolve();
      await finish.promise;
      yield { type: "completed" };
    },
  };
  const done = Effect.runPromiseExit(fireScheduleOnce({ agent, stateRoot, schedule: hourly(), slot: NOW }), {
    signal: abort.signal,
  });
  await entered.promise;
  abort.abort();
  expect(outcomes(stateRoot)).toEqual([undefined]); // claimed, not yet settled
  finish.resolve();
  const exit = await done;
  expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
  expect(outcomes(stateRoot)).toEqual(["completed"]);
});

it("claims an external slot synchronously before a concurrent duplicate can invoke", async () => {
  // The claim is what makes a duplicate delivery a no-op, and it must land BEFORE the model call, not after it.
  const stateRoot = await freshRoot();
  const finish = Promise.withResolvers<void>();
  const invoke = vi.fn(async function* (): AsyncIterable<AgentEvent> {
    await finish.promise;
    yield { type: "completed" };
  });
  const options = { agent: { invoke }, stateRoot, schedule: hourly(), slot: NOW };
  const first = Effect.runPromise(fireScheduleOnce(options));
  try {
    expect(existsSync(join(stateRoot, "schedule", "claims", "job", NOW.toISOString().replace(/[:.]/g, "-")))).toBe(
      true,
    );
    const second = await Effect.runPromise(fireScheduleOnce(options));
    expect(second).toMatchObject({ fired: false, skippedReason: expect.stringContaining("is already claimed") });
    expect(invoke).toHaveBeenCalledOnce();
  } finally {
    finish.resolve();
    await first;
  }
  expect(outcomes(stateRoot)).toEqual(["completed"]);
});
