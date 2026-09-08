import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { type TaskFailure, createTaskTracker, taskEffect, taskFailure } from "../src/channels/kit/tasks.ts";

it("keeps Promise failures typed until the task boundary handles them", () => {
  const work = taskEffect(async () => 1);
  expectTypeOf(work).toEqualTypeOf<Effect.Effect<number, TaskFailure>>();
  // @ts-expect-error -- a task rejection still needs a failure policy
  const infallible: Effect.Effect<number> = work;
  void infallible;
  expectTypeOf(work.pipe(Effect.catchTag("TaskFailure", () => Effect.succeed(0)))).toEqualTypeOf<
    Effect.Effect<number>
  >();
});

it.each(["resolve", "reject"])("joins an interrupted task before cleanup (%s)", async (settle) => {
  const pending = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const abort = new AbortController();
  let cleaned = false;
  const done = Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            cleaned = true;
          }),
        );
        yield* taskEffect(() => {
          entered.resolve();
          return pending.promise;
        });
      }),
    ),
    { signal: abort.signal },
  );
  try {
    await entered.promise;
    abort.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cleaned).toBe(false);
  } finally {
    if (settle === "resolve") pending.resolve();
    else pending.reject(new Error("late task failure"));
    await done;
  }
  expect(cleaned).toBe(true);
  const exit = await done;
  expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
});

it.each(["throw", "reject"])("preserves the original task failure (%s)", async (mode) => {
  const error = new Error("task broke");
  const exit = await Effect.runPromiseExit(
    taskEffect(() => {
      if (mode === "throw") throw error;
      return Promise.reject(error);
    }),
  );
  expect(Exit.isFailure(exit) && taskFailure(exit.cause)).toBe(error);
});

describe("createTaskTracker", () => {
  afterEach(() => vi.restoreAllMocks());

  it("drain waits for tracked tasks; settled tasks drop out", async () => {
    const tracker = createTaskTracker("[test]");
    let done = false;
    let release!: () => void;
    tracker.track(
      new Promise<void>((resolve) => {
        release = resolve;
      }).then(() => {
        done = true;
      }),
    );
    const drain = tracker.drain();
    release();
    await drain;
    expect(done).toBe(true);
    await tracker.drain(); // empty after settle — drains immediately
  });

  it("a rejected (caller-handled) task still settles the drain", async () => {
    const tracker = createTaskTracker("[test]");
    tracker.track(Promise.reject(new Error("boom")).catch(() => "handled"));
    await expect(tracker.drain()).resolves.toBeUndefined();
  });

  it("drain SETTLES a task that rejects, and the rejection is logged rather than swallowed", async () => {
    // `p.catch(log); track(p)` handles the error but hands us a promise that still rejects. Draining
    // must not turn that into a failed turnsIdle for the whole serve — and must still leave a trace.
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const tracker = createTaskTracker("[test]");
    const task = Promise.reject(new Error("boom"));
    let handled: string | undefined;
    task.catch((error: Error) => {
      handled = error.message;
    });
    tracker.track(task);
    await expect(tracker.drain()).resolves.toBeUndefined();
    expect(handled).toBe("boom");
    expect(stderr.mock.calls.flat().join("\n")).toContain("[test] side task rejected: Error: boom");
  });
});
