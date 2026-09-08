import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { createServer } from "node:http";
import { expect, expectTypeOf, it } from "vitest";
import { type AgentcoreFailure, agentcoreOperation, agentcoreRequest } from "../src/channels/agentcore-effects.ts";

it("keeps IO errors typed and joins an issued non-abortable port on interruption", async () => {
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let completed = false;
  const work = agentcoreOperation(async () => {
    entered.resolve();
    await finish.promise;
    completed = true;
  });
  expectTypeOf(work).toEqualTypeOf<Effect.Effect<void, AgentcoreFailure>>();
  // @ts-expect-error -- a storage/activation failure needs a boundary policy
  const infallible: Effect.Effect<void> = work;
  void infallible;
  const abort = new AbortController();
  let settled = false;
  const done = Effect.runPromiseExit(work, { signal: abort.signal }).then((exit) => {
    settled = true;
    return exit;
  });
  await entered.promise;
  abort.abort();
  await new Promise(setImmediate);
  expect(settled).toBe(false);
  finish.resolve();
  const exit = await done;
  expect(completed).toBe(true);
  expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
});

it.each([false, true])("preserves a request failure and closes its signal (synchronous=%s)", async (synchronous) => {
  const error = new Error("request failed");
  let signal: AbortSignal | undefined;
  const work = agentcoreRequest((s) => {
    signal = s;
    if (synchronous) throw error;
    return Promise.reject(error);
  }, 10_000);
  await expect(Effect.runPromise(work.pipe(Effect.mapError((e) => e.cause)))).rejects.toBe(error);
  expect(signal?.aborted).toBe(true);
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
          agentcoreRequest(async (signal) => {
            const response = await fetch(`http://127.0.0.1:${address.port}`, { signal });
            entered.resolve();
            return response.text();
          }, 1_000),
        );
        yield* Effect.promise(() => entered.promise);
        yield* TestClock.adjust(1_000);
        const exit = yield* Fiber.await(fiber);
        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({
          _tag: "AgentcoreFailure",
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
