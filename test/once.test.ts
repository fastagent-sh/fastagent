import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { describe, expect, it } from "vitest";
import { once } from "../src/once.ts";

describe("once", () => {
  it("runs the work once for concurrent callers, and every caller reads its outcome", async () => {
    let runs = 0;
    const gate = Deferred.makeUnsafe<void>();
    const work = once(
      Effect.gen(function* () {
        runs++;
        yield* Deferred.await(gate);
        return "done";
      }),
    );
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const callers = yield* Effect.forEach([1, 2, 3], () => Effect.forkChild(work, { startImmediately: true }));
        yield* Deferred.succeed(gate, undefined);
        return yield* Effect.forEach(callers, Fiber.join);
      }),
    );
    expect(results).toEqual(["done", "done", "done"]);
    expect(runs).toBe(1);
  });

  it("keeps a failure: a later caller gets it instead of running the work again", async () => {
    let runs = 0;
    const work = once(
      Effect.suspend(() => {
        runs++;
        return Effect.fail(new Error("broken"));
      }),
    );
    await expect(Effect.runPromise(work)).rejects.toThrow("broken");
    await expect(Effect.runPromise(work)).rejects.toThrow("broken");
    expect(runs).toBe(1);
  });

  it("a first caller that leaves does not start the work a second time for the next one", async () => {
    let runs = 0;
    const gate = Deferred.makeUnsafe<void>();
    const work = once(
      Effect.gen(function* () {
        runs++;
        yield* Deferred.await(gate);
        return runs;
      }),
    );
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* Effect.forkChild(work, { startImmediately: true });
        const leaving = yield* Effect.forkChild(Fiber.interrupt(first), { startImmediately: true });
        const second = yield* Effect.forkChild(work, { startImmediately: true });
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(leaving);
        return yield* Fiber.join(second);
      }),
    );
    expect(result).toBe(1);
    expect(runs).toBe(1);
  });
});
