import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Stream from "effect/Stream";
import { expect, it, vi } from "vitest";
import { previewPump, serialWriter, renderReply, type PreviewPump } from "../src/channels/kit/delivery.ts";
import { PortFailure, portError, portJoin } from "../src/effect-port.ts";
import { run } from "./channel-effects.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

it("requires a resource scope for an outbound pump", () => {
  const pump = previewPump({ flush: async () => {}, throttleMs: 1, onError: () => {} });
  // @ts-expect-error -- an outbound writer must have an owner
  const unscoped: Effect.Effect<PreviewPump> = pump;
  void unscoped;
});

it("starts the first placeholder synchronously at touch", async () => {
  const flush = vi.fn(async () => {});
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const pump = yield* previewPump({ flush, throttleMs: 1, onError: () => {} });
        pump.touch();
        expect(flush).toHaveBeenCalledOnce();
      }),
    ),
  );
});

it("finish joins an issued frame and its outcome, accepted or rejected", async () => {
  for (const reject of [false, true]) {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const warning = vi.fn();
    const flush = vi.fn(async () => {
      entered.resolve();
      await release.promise;
    });
    let finished = false;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pump = yield* previewPump({ flush, throttleMs: 60_000, onError: warning });
          pump.touch();
          yield* Effect.promise(() => entered.promise);
          pump.touch();
          const stop = yield* Effect.forkChild(
            pump.finish.pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  finished = true;
                }),
              ),
            ),
          );
          const label = reject ? "rejected" : "accepted";
          yield* Effect.promise(tick);
          expect(finished, label).toBe(false);
          if (reject) release.reject(new Error("late frame failure"));
          else release.resolve();
          yield* Fiber.join(stop);
          expect(warning, label).toHaveBeenCalledTimes(reject ? 1 : 0);
          pump.touch();
          yield* Effect.promise(tick);
          expect(flush, label).toHaveBeenCalledTimes(1);
        }),
      ),
    );
    expect(finished, reject ? "rejected" : "accepted").toBe(true);
  }
});

it("scope close cancels a mutation slot without issuing or leaking the pending frame", async () => {
  const flush = vi.fn(async () => {});
  await Effect.runPromise(
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      const sleep = vi.spyOn(clock, "sleep");
      yield* Effect.scoped(
        Effect.gen(function* () {
          const pump = yield* previewPump({
            flush,
            throttleMs: 0,
            beforeFlush: Effect.sleep(60_000),
            onError: () => {},
          });
          pump.touch();
          yield* TestClock.adjust(59_999);
          expect(sleep).toHaveBeenCalled();
          expect(flush).not.toHaveBeenCalled();
        }),
      );
      yield* TestClock.adjust(60_000);
      expect(flush).not.toHaveBeenCalled();
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

it("a defective preview error callback remains visible at finish", async () => {
  const error = new Error("diagnostic callback broke");
  await expect(
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pump = yield* previewPump({
            flush: async () => {
              throw new Error("frame failed");
            },
            throttleMs: 1,
            onError: () => {
              throw error;
            },
          });
          pump.touch();
          yield* Effect.promise(tick);
          pump.touch(); // a later frame must not hide an earlier diagnostic defect
          yield* pump.finish;
        }),
      ),
    ),
  ).rejects.toBe(error);
});

it("scope interruption drains accepted native writes in order before releasing", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const abort = new AbortController();
  const order: string[] = [];
  const done = Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const writer = yield* serialWriter();
        writer.enqueue(async () => {
          entered.resolve();
          await release.promise;
          order.push("append");
        });
        writer.enqueue(async () => {
          order.push("clear");
        });
        yield* Effect.never;
      }),
    ),
    { signal: abort.signal },
  );
  await entered.promise;
  abort.abort();
  await tick();
  expect(order).toEqual([]);
  release.resolve();
  const exit = await done;
  expect(order).toEqual(["append", "clear"]);
  expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
});

it("a failed writer surfaces its original cause, and closed admission fails visibly", async () => {
  const error = new Error("append failed");
  await expect(
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const writer = yield* serialWriter();
          writer.enqueue(async () => {
            throw error;
          });
          yield* writer.finish;
        }),
      ),
    ),
  ).rejects.toBe(error);
  await run(
    Effect.scoped(
      Effect.gen(function* () {
        const writer = yield* serialWriter();
        yield* writer.finish;
        expect(() => writer.enqueue(async () => {})).toThrow("delivery writer is closed");
      }),
    ),
  );
});

it("preserves a source OR completed failure without duplicate terminal delivery", async () => {
  for (const phase of ["source", "completed"] as const) {
    const primary = new Error("primary failure");
    const secondary = new Error("notice delivery failed");
    const warning = vi.spyOn(console, "error").mockImplementation(() => {});
    const settle = vi.fn(() =>
      portJoin(async () => {
        throw phase === "source" ? secondary : primary;
      }),
    );
    await expect(
      run(
        Effect.scoped(
          renderReply(
            phase === "source" ? Stream.fail(new PortFailure(primary)) : Stream.succeed({ type: "completed" } as const),
            {
              label: "[test]",
              finish: Effect.void,
              onEvent: () => {},
              answer: () => "answer",
              formatError: () => "notice",
              settle,
            },
          ),
        ),
      ),
    ).rejects.toBe(primary);
    expect(settle, phase).toHaveBeenCalledOnce();
    if (phase === "source") expect(warning, phase).toHaveBeenCalledWith(expect.stringContaining(secondary.message));
    warning.mockRestore();
  }
});

it("source failure remains primary when writer cleanup also fails", async () => {
  const primary = new Error("source failed");
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const writer = yield* serialWriter();
        writer.enqueue(async () => {
          throw new Error("cleanup failed");
        });
        yield* Effect.fail(primary);
      }),
    ),
  );
  expect(Exit.isFailure(exit) && portError(exit.cause)).toBe(primary);
});
