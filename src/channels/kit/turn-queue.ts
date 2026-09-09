/** Per-session FIFO execution. */
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";
import { log } from "../../log.ts";
import { beginWork } from "../busy.ts";
import { portError } from "../../effect-port.ts";

export interface TurnQueue<T> {
  accept(rec: T): void;
  /** Observation only: production shutdown does not drain channel turns. */
  idle(): Promise<void>;
}

export function createTurnQueue<T extends { session: string }>(opts: {
  label: string;
  /** The queue diagnoses escaped failures and closes this turn's resources before its successor runs. */
  run: (rec: T) => Effect.Effect<void, unknown, Scope.Scope>;
  /** Synchronous queue feedback for a turn behind an active or queued predecessor. */
  onQueuedBehind?: (rec: T) => void;
}): TurnQueue<T> {
  const { label, run, onQueuedBehind } = opts;
  const chains = new Map<string, Fiber.Fiber<void>>();
  return {
    accept(rec) {
      if (chains.has(rec.session)) onQueuedBehind?.(rec);
      const prev = chains.get(rec.session);
      // Admission counts immediately, including while waiting behind another turn.
      const workDone = beginWork();
      const fiber = Effect.runFork(
        Effect.scoped(
          Effect.gen(function* () {
            // Publish the tail before execution can finish or submit another turn.
            yield* Effect.yieldNow;
            if (prev) yield* Fiber.await(prev);
            yield* run(rec);
          }),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() =>
              log.error(
                `${label} turn runner rejected (session=${rec.session}; own your error surface in run()): ${String(portError(cause))}`,
              ),
            ),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              workDone();
              if (chains.get(rec.session) === fiber) chains.delete(rec.session);
            }),
          ),
        ),
      );
      chains.set(rec.session, fiber);
    },
    idle: () =>
      Effect.runPromise(
        Effect.gen(function* () {
          // A finishing turn may enqueue more work.
          while (chains.size > 0) yield* Fiber.awaitAll([...chains.values()]);
        }),
      ),
  };
}
