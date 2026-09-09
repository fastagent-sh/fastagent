import type { AgentSession } from "@earendil-works/pi-coding-agent";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Scope from "effect/Scope";
import { expect, expectTypeOf, it } from "vitest";
import type { PortFailure } from "../src/effect-port.ts";
import { portAbort } from "../src/effect-port.ts";
import { acquireSession, acquireSessionLease } from "../src/engines/pi/session-effects.ts";
import { inProcessLease } from "../src/engines/pi/turn-kit.ts";

it("retains the resource scope and both expected failure channels until explicitly handled", () => {
  const opened = acquireSession(async () => ({}) as AgentSession, "types");
  const leased = acquireSessionLease(inProcessLease(), "types");
  expectTypeOf(opened).toEqualTypeOf<Effect.Effect<AgentSession, PortFailure, Scope.Scope>>();
  // @ts-expect-error -- acquisition still requires an owned resource scope
  const unscoped: Effect.Effect<AgentSession, PortFailure> = opened;
  // @ts-expect-error -- SDK failures remain expected failures until translated
  const infallible: Effect.Effect<AgentSession, never, Scope.Scope> = opened;
  // @ts-expect-error -- the shared lease may reject admission
  const uncontended: Effect.Effect<() => void, never, Scope.Scope> = leased;
  void [unscoped, infallible, uncontended];
  const handled = Effect.scoped(opened).pipe(Effect.catchTag("PortFailure", () => Effect.succeed(null)));
  expectTypeOf(handled).toEqualTypeOf<Effect.Effect<AgentSession | null>>();
});

it("holds the session lease until outstanding SDK work has been joined", async () => {
  const pending = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const abort = new AbortController();
  const lease = inProcessLease();
  const done = Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        yield* acquireSessionLease(lease, "held");
        yield* portAbort(
          "prompt",
          () => {
            entered.resolve();
            return pending.promise;
          },
          () => {},
        );
      }),
    ),
    { signal: abort.signal },
  );
  try {
    await entered.promise;
    abort.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    // The next turn must not be admitted while the interrupted one is still running.
    expect(lease.tryAcquire("held")).toBeNull();
  } finally {
    pending.resolve();
    await done;
  }
  const exit = await done;
  expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
  const release = lease.tryAcquire("held");
  expect(release).toBeTypeOf("function");
  release?.();
});
