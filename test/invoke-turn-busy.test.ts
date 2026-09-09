import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Agent, type AgentEvent, SESSION_BUSY_CODE } from "../src/agent.ts";
import { type BusyRetry, busyRetryStream } from "../src/channels/kit/invoke-turn-kit.ts";
import { telegramTurnStream } from "../src/channels/telegram/invoke-turn.ts";
import type { PortFailure } from "../src/effect-port.ts";
import { run as runEffect } from "./channel-effects.ts";
import { log } from "../src/log.ts";

/** A fake agent scripted per-invoke: call N yields script[N] (the last entry repeats). */
function scriptedAgent(script: AgentEvent[][]) {
  let calls = 0;
  const agent: Agent = {
    async *invoke() {
      const events = script[Math.min(calls++, script.length - 1)] ?? [];
      for (const e of events) yield e;
    },
  };
  return { agent, invokes: () => calls };
}

const busyEvent: AgentEvent = {
  type: "failed",
  details: "session busy: a turn is already in flight",
  retryable: true,
  code: SESSION_BUSY_CODE,
};
const ok: AgentEvent[] = [{ type: "text", delta: "answer" }, { type: "completed" }];

const FAST: BusyRetry = { delayMs: 10, maxWaitMs: 500 };
const noAttachments = { primary: {}, buffered: { files: [], images: [], skipped: 0 } };

async function run(agent: Agent, retry: BusyRetry = FAST): Promise<AgentEvent[]> {
  const transport = {
    api: "http://t.test",
    botToken: "B",
    chatId: 1,
    filesDir: await mkdtemp(join(tmpdir(), "fa-")),
  };
  return read(telegramTurnStream(agent, "s", "hi", transport, noAttachments, undefined, retry));
}

const read = (events: Stream.Stream<AgentEvent, PortFailure>) => runEffect(Stream.runCollect(events));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const relay = (agent: Agent, onCompleted?: () => void, busyRetry = FAST) =>
  busyRetryStream(agent, { session: "s" }, { text: "hi" }, { label: "[test]", onCompleted, busyRetry });

it("uses a virtual clock and closes the rejected attempt before its retry delay", async () => {
  const order: string[] = [];
  let calls = 0;
  const agent: Agent = {
    async *invoke() {
      const id = ++calls;
      order.push(`invoke ${id}`);
      try {
        yield* id === 1 ? [busyEvent] : ok;
      } finally {
        order.push(`close ${id}`);
      }
    },
  };
  await Effect.runPromise(
    Effect.gen(function* () {
      const work = yield* Stream.runCollect(
        busyRetryStream(
          agent,
          { session: "s" },
          { text: "hi" },
          {
            label: "[test]",
            busyRetry: { delayMs: 60_000, maxWaitMs: 180_000 },
          },
        ),
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust(59_999);
      expect(order).toEqual(["invoke 1", "close 1"]);
      yield* TestClock.adjust(1);
      expect(yield* Fiber.join(work)).toEqual(ok);
      expect(order).toEqual(["invoke 1", "close 1", "invoke 2", "close 2"]);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

it("cancels an active backoff without another invoke or a leaked timer", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const { agent, invokes } = scriptedAgent([[busyEvent]]);
  const abort = new AbortController();
  const done = Effect.runPromiseExit(
    Stream.runDrain(relay(agent, undefined, { delayMs: 60_000, maxWaitMs: 180_000 })),
    { signal: abort.signal },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(vi.getTimerCount()).toBe(1);
  abort.abort();
  const exit = await done;
  expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(180_000);
  expect(invokes()).toBe(1);
});

it("keeps source pulls and completion commits behind consumer demand", async () => {
  const onCompleted = vi.fn();
  const close = vi.fn(async () => ({ done: true as const, value: undefined }));
  const next = vi
    .fn()
    .mockResolvedValueOnce({ done: false, value: { type: "text", delta: "answer" } })
    .mockResolvedValueOnce({ done: false, value: { type: "completed" } });
  const agent: Agent = { invoke: () => ({ [Symbol.asyncIterator]: () => ({ next, return: close }) }) };
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const pull = yield* Stream.toPull(relay(agent, onCompleted));
        expect(next).not.toHaveBeenCalled();
        expect(yield* pull).toEqual([ok[0]]);
        expect(next).toHaveBeenCalledTimes(1);
        expect(onCompleted).not.toHaveBeenCalled();
        expect(yield* pull).toEqual([ok[1]]);
        expect(onCompleted).toHaveBeenCalledTimes(1);
        expect(close).not.toHaveBeenCalled();
      }),
    ),
  );

  expect(close).toHaveBeenCalledTimes(1);
});

it("preserves natural exhaustion without calling return on an already-closed source", async () => {
  const close = vi.fn(async () => {
    throw new Error("source was already closed");
  });
  const next = vi
    .fn()
    .mockResolvedValueOnce({ done: false, value: { type: "completed" } })
    .mockResolvedValueOnce({ done: true, value: undefined });
  const agent: Agent = { invoke: () => ({ [Symbol.asyncIterator]: () => ({ next, return: close }) }) };
  expect(await read(relay(agent))).toEqual([{ type: "completed" }]);
  expect(close).not.toHaveBeenCalled();
});

it("commit failures keep their identity, close the source, and never trigger retry", async () => {
  const error = new Error("commit failed");
  const { agent, invokes } = scriptedAgent([ok]);
  await expect(
    read(
      relay(agent, () => {
        throw error;
      }),
    ),
  ).rejects.toBe(error);
  expect(invokes()).toBe(1);
});

it("logs cleanup failure without replacing a commit error or exposing its payload", async () => {
  const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
  const primary = new Error("commit broke");
  const cleanup = new Error("source close broke", { cause: { payload: "private-provider-data" } });
  const agent: Agent = {
    async *invoke() {
      try {
        yield { type: "completed" };
      } finally {
        // biome-ignore lint/correctness/noUnsafeFinally: inject an iterator cleanup failure.
        throw cleanup;
      }
    },
  };
  await expect(
    read(
      relay(agent, () => {
        throw primary;
      }),
    ),
  ).rejects.toBe(primary);
  expect(warn.mock.calls.flat().join(" ")).toContain("source close broke");
  expect(warn.mock.calls.flat().join(" ")).not.toContain("private-provider-data");
});

it("diagnoses source cleanup failure when a paused consumer cancels", async () => {
  const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
  const source = {
    next: vi.fn(async () => ({ done: false as const, value: { type: "text" as const, delta: "partial" } })),
    return: vi.fn(async () => {
      throw new Error("cancel cleanup broke");
    }),
  };
  const agent: Agent = { invoke: () => ({ [Symbol.asyncIterator]: () => source }) };
  const pulled = Promise.withResolvers<void>();
  const abort = new AbortController();
  const done = Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const pull = yield* Stream.toPull(relay(agent));
        yield* pull;
        pulled.resolve();
        yield* Effect.never;
      }),
    ),
    { signal: abort.signal },
  );
  await pulled.promise;
  abort.abort();
  await done;
  expect(source.return).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls.flat().join(" ")).toContain("cancel cleanup broke");
});

it("a failed close of a busy attempt surfaces instead of retrying ambiguous work", async () => {
  const error = new Error("close failed");
  const invoke = vi.fn(async function* () {
    try {
      yield busyEvent;
    } finally {
      // biome-ignore lint/correctness/noUnsafeFinally: inject an iterator cleanup failure.
      throw error;
    }
  });
  await expect(read(relay({ invoke }))).rejects.toBe(error);
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("passes future events and extended scope through without reopening the retry window", async () => {
  const future = { type: "future", data: "x" } as unknown as AgentEvent;
  const scope = { session: "s", parentSession: "parent", branchHints: ["entry"] };
  const invoke = vi.fn(async function* () {
    yield future;
    yield busyEvent;
  });
  expect(await read(busyRetryStream({ invoke }, scope, { text: "hi" }, { label: "[test]" }))).toEqual([
    future,
    busyEvent,
  ]);
  expect(invoke).toHaveBeenCalledExactlyOnceWith(scope, { text: "hi" });
});

describe("telegramTurnStream busy-wait (the reverse of the scheduler's wake defer)", () => {
  it("a fail-fast busy reject retries (bounded) and the user gets the ANSWER, not an error", async () => {
    // Invoke 1: busy (an external wake turn holds the lease). Invoke 2: the lease freed — normal turn.
    const { agent, invokes } = scriptedAgent([[busyEvent], ok]);
    const events = await run(agent);
    expect(invokes()).toBe(2); // waited + re-invoked
    expect(events.map((e) => e.type)).toEqual(["text", "completed"]); // the busy failure never surfaced
  });

  it("an exhausted busy wait surfaces the busy failure (bounded, not forever)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { agent, invokes } = scriptedAgent([[busyEvent]]); // always busy
    const events = await run(agent, { delayMs: 20, maxWaitMs: 100 });
    expect(events.at(-1)).toMatchObject({ type: "failed", code: SESSION_BUSY_CODE }); // surfaced after the wait
    expect(invokes()).toBeGreaterThan(1); // it did retry before giving up
    expect(invokes()).toBeLessThan(10); // …boundedly
    vi.restoreAllMocks();
  });

  it("a non-busy failure is yielded immediately — no retry (side effects may have run)", async () => {
    const failed: AgentEvent = { type: "failed", details: "provider 500", retryable: true };
    const { agent, invokes } = scriptedAgent([[failed]]);
    const events = await run(agent);
    expect(invokes()).toBe(1);
    expect(events).toEqual([failed]);
  });

  it("a busy event AFTER the first is passed through, never retried (the turn already started)", async () => {
    const { agent, invokes } = scriptedAgent([[{ type: "text", delta: "partial" }, busyEvent]]);
    const events = await run(agent);
    expect(invokes()).toBe(1); // no re-run of a started turn
    expect(events.map((e) => e.type)).toEqual(["text", "failed"]);
  });
});
