import type { AgentSession } from "@earendil-works/pi-coding-agent";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Scope from "effect/Scope";
import { expect, expectTypeOf, it, vi } from "vitest";
import {
  acquireSession,
  acquireSessionLease,
  SessionOperationError,
  sessionWork,
} from "../src/engines/pi/session-effects.ts";
import { inProcessLease } from "../src/engines/pi/turn-kit.ts";
import { log } from "../src/log.ts";

it("retains the resource scope and both expected failure channels until explicitly handled", () => {
  const opened = acquireSession(async () => ({}) as AgentSession, "types");
  const leased = acquireSessionLease(inProcessLease(), "types");
  expectTypeOf(opened).toEqualTypeOf<Effect.Effect<AgentSession, SessionOperationError, Scope.Scope>>();
  // @ts-expect-error -- acquisition still requires an owned resource scope
  const unscoped: Effect.Effect<AgentSession, SessionOperationError> = opened;
  // @ts-expect-error -- SDK failures remain expected failures until translated
  const infallible: Effect.Effect<AgentSession, never, Scope.Scope> = opened;
  // @ts-expect-error -- the shared lease may reject admission
  const uncontended: Effect.Effect<() => void, never, Scope.Scope> = leased;
  void [unscoped, infallible, uncontended];
  const handled = Effect.scoped(opened).pipe(Effect.catchTag("SessionOperationError", () => Effect.succeed(null)));
  expectTypeOf(handled).toEqualTypeOf<Effect.Effect<AgentSession | null>>();
});

it.each(["resolve", "reject"])("joins outstanding SDK work (%s) even when its abort hook fails", async (settle) => {
  const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
  const pending = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const abortCalled = Promise.withResolvers<void>();
  const abort = new AbortController();
  const lease = inProcessLease();
  let disposed = false;
  const done = Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        yield* acquireSessionLease(lease, "abort-error");
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            disposed = true;
          }),
        );
        yield* sessionWork(
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
    expect(disposed).toBe(false);
    expect(lease.tryAcquire("abort-error")).toBeNull();
    expect(warn.mock.calls.flat().join(" ")).toContain("abort hook failed");
  } finally {
    if (settle === "resolve") pending.resolve();
    else pending.reject(new Error("SDK failed after cancellation"));
    await done;
    warn.mockRestore();
  }
  const exit = await done;
  expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
  expect(disposed).toBe(true);
  const release = lease.tryAcquire("abort-error");
  expect(release).toBeTypeOf("function");
  release?.();
});

it("preserves a synchronous SDK failure without running release for an uncreated Promise", async () => {
  const abort = new AbortController();
  let stopped = false;
  const exit = await Effect.runPromiseExit(
    sessionWork(
      "prompt",
      () => {
        abort.abort();
        throw new Error("synchronous SDK failure");
      },
      () => {
        stopped = true;
      },
    ),
    { signal: abort.signal },
  );
  expect(stopped).toBe(false);
  expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBeInstanceOf(SessionOperationError);
});
