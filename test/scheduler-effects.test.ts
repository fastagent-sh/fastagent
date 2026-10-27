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
import type { InvokeRequest } from "../src/agent-api.ts";
import type { TurnEvent } from "../src/channels/kit/invoke-turn-kit.ts";
import { scriptedRun } from "./scripted-run.ts";
import { scriptedAgent } from "./scripted-agent.ts";
import { durableSubject } from "./durable-subject.ts";
import { activeWork } from "../src/channels/busy.ts";
import type { PortFailure } from "../src/effect-port.ts";
import {
  createScheduler,
  fireScheduleOnce,
  type ScheduleFireOutcome,
  type Scheduler,
  scheduleSessions,
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

/** An agent that runs `script` for each message it is sent; `sent` lists each message's session. */
const agentRunning = (script: (request: InvokeRequest & { sessionId: string }) => AsyncIterable<TurnEvent>) => {
  const agent = scriptedAgent(script);
  return { agent, sent: () => agent.sent.map((request) => request.sessionId) };
};
/** The session the scheduler gave schedule `name`. */
const sessionOf = (stateRoot: string, name: string) => scheduleSessions(stateRoot).get(name);

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
          const agent = {
            async createSession() { return { ok: true, sessionId: "s" }; },
            async invoke() {
              await new Promise((r) => setTimeout(r, 150));
              const message = { messageId: "m", status: "done", outcome: { status: "completed" } };
              return { ok: true, sessionId: "s", message, duplicate: false, wait: async () => ({ ok: true, message }) };
            },
          };
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
    const agent = {
      async createSession() { return { ok: true, sessionId: "s" }; },
      async invoke() { process.send("running"); await new Promise(() => {}); },
    };
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
    const { agent, sent } = agentRunning(async function* (request) {
      yield* scriptedRun(request);
    });
    const s = Effect.runSync(createScheduler({ agent, stateRoot, schedules, now: () => NOW }));
    try {
      s.start();
      await vi.waitFor(() => expect(sent()).toEqual(kind === "cron" ? [] : ["next"]));
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
  const { agent, sent } = agentRunning(async function* (request) {
    yield* scriptedRun(request);
  });
  const base = activeWork();
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW.getTime());
      const s = yield* createScheduler({ agent, stateRoot, schedules: [hourly()] });
      try {
        s.start();
        yield* TestClock.adjust(29 * 60_000);
        expect(sent()).toEqual([]);
        expect(activeWork()).toBe(base);
        yield* TestClock.adjust(60_000);
        yield* Effect.promise(tick);
        expect(sent()).toEqual([sessionOf(stateRoot, "job")]);
        expect(readFires(stateRoot, "job")[0]).toMatchObject({
          firedAt: "2026-07-07T11:00:00.000Z",
          outcome: "completed",
          ms: 0,
        });
        s.stop();
        yield* TestClock.adjust(2 * 60 * 60_000);
        expect(sent()).toHaveLength(1);
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
  const { agent, sent } = agentRunning(async function* (request) {
    const [accepted, ...rest] = scriptedRun(request);
    if (accepted) yield accepted;
    await finish.promise;
    yield* rest;
  });
  const names = () => sent().map((session) => (session === sessionOf(stateRoot, "a") ? "a" : "b"));
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW.getTime());
      const s = yield* createScheduler({ agent, stateRoot, schedules: [hourly("a"), hourly("b")] });
      try {
        s.start();
        yield* TestClock.adjust(2 * 60 * 60_000);
        yield* Effect.promise(tick);
        expect(names().sort()).toEqual(["a", "b"]);
        finish.resolve();
        yield* Effect.promise(tick);
        yield* TestClock.adjust(29 * 60_000);
        expect(sent()).toHaveLength(2);
        yield* TestClock.adjust(60_000);
        yield* Effect.promise(tick);
        expect(names().sort()).toEqual(["a", "a", "b", "b"]);
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
  const { agent, sent } = agentRunning(async function* (request) {
    yield* scriptedRun(request);
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      const s = yield* createScheduler({
        agent,
        stateRoot,
        schedules: [{ ...hourly(), cron: "0 9 * * *" }],
        now: () => wall,
      });
      try {
        s.start();
        wall = new Date("2026-07-06T10:30:00Z");
        yield* TestClock.adjust(6 * 60 * 60_000);
        expect(sent()).toEqual([]);
        wall = new Date("2026-07-09T10:30:00Z");
        yield* TestClock.adjust(6 * 60 * 60_000);
        yield* Effect.promise(tick);
        expect(sent()).toHaveLength(1);
        expect(lastFire(stateRoot, "job")).toBe(wall.toISOString());
      } finally {
        s.stop();
      }
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

it("publishes the running loop before an agent callback re-enters stop", async () => {
  const stateRoot = await freshRoot();
  seedFiredSlots(stateRoot, ["a", "b"], "2026-07-07T08:00:00Z");
  let s: Scheduler;
  const scripted = scriptedAgent((request) => scriptedRun(request));
  // The first thing a fire asks of the agent, synchronously: its schedule's session.
  const createSession = vi.fn((options?: Parameters<typeof scripted.createSession>[0]) => {
    s.stop();
    return scripted.createSession(options);
  });
  const invoke = vi.fn(scripted.invoke);
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW.getTime());
      s = yield* createScheduler({
        agent: { ...scripted, createSession, invoke },
        stateRoot,
        schedules: [hourly("a"), hourly("b")],
      });
      try {
        s.start();
        yield* Effect.promise(tick);
        yield* TestClock.adjust(2 * 60 * 60_000);
        yield* Effect.promise(tick);
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
      const s = yield* createScheduler({ agent: scriptedAgent(() => []), stateRoot, schedules: [] });
      s.start();
      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining("wake-up poll: stopped unexpectedly: Error: clock failed"),
      );
      s.stop();
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

it("a failing send or a failing wait is the fire's failure, before or after its receipt", async () => {
  for (const accepted of [false, true]) {
    const stateRoot = await freshRoot();
    const error = new Error("iterator failed", { cause: { payload: "private-provider-data" } });
    const logged = vi.spyOn(log, "error").mockImplementation(() => {});
    const { agent, sent } = agentRunning(async function* (request) {
      if (accepted) yield scriptedRun(request)[0] as TurnEvent;
      throw error;
    });
    writeScheduleFile(scheduleFile(stateRoot, "wakeups"), [
      { id: "w", session: "s", prompt: "go", fireAt: "2026-07-07T09:00:00Z" },
    ]);
    const s = Effect.runSync(createScheduler({ agent, stateRoot, schedules: [], now: () => NOW }));
    try {
      s.start();
      const label = `accepted=${accepted}`;
      // A wake-up has no claim to settle, so the log line IS the record of the failure.
      await vi.waitFor(() => expect(logged.mock.calls.flat().join(" "), label).toContain("Error: iterator failed"));
      expect(listWakeups(stateRoot), label).toEqual([]);
      expect(sent(), label).toEqual(["s"]);
      expect(logged.mock.calls.flat().join(" "), label).not.toContain("private-provider-data");
    } finally {
      s.stop();
    }
  }
});

it("keeps claim IO failures typed and never invokes, and never burns the slot", async () => {
  const stateRoot = await freshRoot();
  // A FILE where `claims/job/` belongs: `claimSlot` throws ENOTDIR, and it throws BEFORE creating the claim — so the
  // slot is still there to run once the fault is fixed, which is the whole reason the claim is the only state write.
  await mkdir(join(stateRoot, "schedule", "claims"), { recursive: true });
  await writeFile(join(stateRoot, "schedule", "claims", "job"), "");
  const { agent, sent } = agentRunning(async function* (request) {
    yield* scriptedRun(request);
  });
  const work = fireScheduleOnce({ agent, stateRoot, schedule: hourly(), slot: NOW });
  expectTypeOf(work).toEqualTypeOf<Effect.Effect<ScheduleFireOutcome, PortFailure>>();
  // @ts-expect-error -- a failed durable claim still needs a failure policy
  const infallible: Effect.Effect<ScheduleFireOutcome> = work;
  void infallible;
  const exit = await Effect.runPromiseExit(work);
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit))
    expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "PortFailure", cause: expect.any(Error) });
  expect(sent()).toEqual([]);

  // The fault is fixed and the SAME slot still fires: a failed state write must not consume it.
  await rm(join(stateRoot, "schedule", "claims", "job"));
  const retry = await Effect.runPromise(fireScheduleOnce({ agent, stateRoot, schedule: hourly(), slot: NOW }));
  expect(retry).toMatchObject({ fired: true });
  expect(outcomes(stateRoot)).toEqual(["completed"]); // the recovered slot is the only fire on record
});

it("a boot-time cron-state fault fails start synchronously before any loop runs", async () => {
  const stateRoot = await freshRoot();
  await mkdir(join(stateRoot, "schedule", "claims"), { recursive: true });
  await writeFile(join(stateRoot, "schedule", "claims", "job"), "");
  const { agent, sent } = agentRunning(async function* (request) {
    yield* scriptedRun(request);
  });
  const s = Effect.runSync(createScheduler({ agent, stateRoot, schedules: [hourly()] }));
  expect(() => s.start()).toThrow(/ENOTDIR|not a directory/);
  s.stop();
  await tick();
  expect(sent()).toEqual([]);
});

it("an interrupted external fire joins its claimed turn and its settlement", async () => {
  const stateRoot = await freshRoot();
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const abort = new AbortController();
  const { agent } = agentRunning(async function* (request) {
    entered.resolve();
    await finish.promise;
    yield* scriptedRun(request);
  });
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
  const { agent, sent } = agentRunning(async function* (request) {
    await finish.promise;
    yield* scriptedRun(request);
  });
  const options = { agent, stateRoot, schedule: hourly(), slot: NOW };
  const first = Effect.runPromise(fireScheduleOnce(options));
  try {
    expect(existsSync(join(stateRoot, "schedule", "claims", "job", NOW.toISOString().replace(/[:.]/g, "-")))).toBe(
      true,
    );
    const second = await Effect.runPromise(fireScheduleOnce(options));
    expect(second).toMatchObject({ fired: false, skippedReason: expect.stringContaining("is already claimed") });
    await vi.waitFor(() => expect(sent()).toHaveLength(1));
  } finally {
    finish.resolve();
    await first;
  }
  expect(outcomes(stateRoot)).toEqual(["completed"]);
});

it("stopping the scheduler detaches from a running fire, and the message goes on to its end", async () => {
  // A stop interrupts the scheduler's loops, and so their waits for the messages they sent; a Caller that stops
  // waiting only detaches (SPEC.md §3.1), so the message still finishes, and what it did is in its session.
  const subject = durableSubject();
  try {
    const agent = await subject.start();
    const stateRoot = await freshRoot();
    seedFiredSlots(stateRoot, ["job"], "2026-07-07T09:00:00Z");
    const s = Effect.runSync(
      createScheduler({ agent, stateRoot, schedules: [{ ...hourly(), prompt: "hold" }], now: () => NOW }),
    );
    s.start();
    await vi.waitFor(() => expect(subject.held()).toBe(1));
    s.stop();
    await tick();
    expect(subject.held()).toBe(1);
    subject.release();
    const sessionId = sessionOf(stateRoot, "job") as string;
    await vi.waitFor(async () => {
      const read = await agent.read(sessionId, { limit: 1 });
      expect(read.ok && read.state.status).toBe("idle");
    });
    expect(await agent.getMessage(sessionId, { idempotencyKey: "2026-07-07T10:00:00.000Z" })).toMatchObject({
      status: "done",
      outcome: { status: "completed" },
    });
  } finally {
    await subject.stop();
  }
});

it("a schedule's occurrence on a busy session is skipped, not queued behind the running message", async () => {
  const subject = durableSubject();
  try {
    const agent = await subject.start();
    const stateRoot = await freshRoot();
    const sessionId = await scheduleSessions(stateRoot).of("job", agent);
    const running = await agent.invoke({ sessionId, content: [{ type: "text", text: "hold" }] });
    expect(running.ok).toBe(true);
    await vi.waitFor(() => expect(subject.held()).toBe(1));
    const outcome = await Effect.runPromise(
      fireScheduleOnce({ agent, stateRoot, schedule: hourly(), slot: NOW, now: () => NOW }),
    );
    expect(outcome).toMatchObject({ fired: false, skipped: true });
    const state = await agent.read(sessionId, { limit: 1 });
    expect(state.ok && state.state.queued).toEqual([]);
  } finally {
    await subject.stop();
  }
});
