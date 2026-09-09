import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { createServer } from "node:http";
import { expect, expectTypeOf, it, vi } from "vitest";
import { type PortFailure, portAbort, portError, portJoin, portRequest } from "../src/effect-port.ts";
import { log } from "../src/log.ts";

it("keeps a Promise port's failure typed until a boundary handles it", () => {
  const work = portJoin(async () => 1);
  expectTypeOf(work).toEqualTypeOf<Effect.Effect<number, PortFailure>>();
  // @ts-expect-error -- a port rejection still needs a failure policy
  const infallible: Effect.Effect<number> = work;
  void infallible;
  expectTypeOf(work.pipe(Effect.catchTag("PortFailure", () => Effect.succeed(0)))).toEqualTypeOf<
    Effect.Effect<number>
  >();
});

it("portJoin joins interrupted work before cleanup, however it settles", async () => {
  for (const settle of ["resolve", "reject"]) {
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
          yield* portJoin(() => {
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
      expect(cleaned, settle).toBe(false);
    } finally {
      if (settle === "resolve") pending.resolve();
      else pending.reject(new Error("late port failure"));
      await done;
    }
    expect(cleaned, settle).toBe(true);
    const exit = await done;
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause), settle).toBe(true);
  }
});

it("preserves the original failure whether the port throws or rejects", async () => {
  for (const mode of ["throw", "reject"]) {
    const error = new Error("port broke");
    const exit = await Effect.runPromiseExit(
      portJoin(() => {
        if (mode === "throw") throw error;
        return Promise.reject(error);
      }),
    );
    expect(Exit.isFailure(exit) && portError(exit.cause), mode).toBe(error);
  }
});

it("portAbort joins outstanding work even when its hook fails, however it settles", async () => {
  for (const settle of ["resolve", "reject"]) {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const pending = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const abortCalled = Promise.withResolvers<void>();
    const abort = new AbortController();
    let released = false;
    const done = Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              released = true;
            }),
          );
          yield* portAbort(
            "prompt",
            () => {
              entered.resolve();
              return pending.promise;
            },
            () => {
              abortCalled.resolve();
              throw new Error("abort hook failed");
            },
          );
        }),
      ),
      { signal: abort.signal },
    );
    try {
      await entered.promise;
      abort.abort();
      await abortCalled.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(released, settle).toBe(false);
      // The label names WHICH abort could not be delivered — one tag, but distinguishable diagnostics.
      expect(warn.mock.calls.flat().join(" "), settle).toContain("prompt abort failed during cleanup");
      expect(warn.mock.calls.flat().join(" "), settle).toContain("abort hook failed");
    } finally {
      if (settle === "resolve") pending.resolve();
      else pending.reject(new Error("port failed after cancellation"));
      await done;
      warn.mockRestore();
    }
    const exit = await done;
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause), settle).toBe(true);
    expect(released, settle).toBe(true);
  }
});

it("portAbort does not run its hook for a Promise that was never created", async () => {
  const abort = new AbortController();
  let stopped = false;
  const exit = await Effect.runPromiseExit(
    portAbort(
      "prompt",
      () => {
        abort.abort();
        throw new Error("synchronous port failure");
      },
      () => {
        stopped = true;
      },
    ),
    { signal: abort.signal },
  );
  expect(stopped).toBe(false);
  expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({ _tag: "PortFailure" });
});

it("portRequest preserves a failure and closes its signal, thrown synchronously or rejected", async () => {
  for (const synchronous of [false, true]) {
    const error = new Error("request failed");
    let signal: AbortSignal | undefined;
    const work = portRequest((s) => {
      signal = s;
      if (synchronous) throw error;
      return Promise.reject(error);
    }, 10_000);
    const label = synchronous ? "synchronous" : "rejected";
    await expect(Effect.runPromise(work.pipe(Effect.mapError((e) => e.cause))), label).rejects.toBe(error);
    expect(signal?.aborted, label).toBe(true);
  }
});

it("a virtual deadline aborts and joins a real fetch response body", async () => {
  const entered = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const server = createServer((_req, res) => {
    res.writeHead(200);
    res.write("partial");
    res.once("close", () => closed.resolve());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected an IP listener");
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          portRequest(async (signal) => {
            const response = await fetch(`http://127.0.0.1:${address.port}`, { signal });
            entered.resolve();
            return response.text();
          }, 1_000),
        );
        yield* Effect.promise(() => entered.promise);
        yield* TestClock.adjust(1_000);
        const exit = yield* Fiber.await(fiber);
        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({
          _tag: "PortFailure",
          cause: { _tag: "TimeoutError" },
        });
        yield* Effect.promise(() => closed.promise);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
