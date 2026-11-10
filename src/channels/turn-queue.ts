/**
 * Per-conversation execution. A turn waits for its predecessor to RELEASE the conversation: a serial turn releases it
 * when it ends, a steering turn as soon as its message is recorded with the Agent, so that the next input is prepared
 * and sent in arrival order while the earlier turn is still being answered.
 */
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";
import { log } from "../log.ts";
import { beginWork } from "./busy.ts";
import { portError } from "../effect-port.ts";

/** A turn's place in its conversation. */
export interface TurnSlot {
  /** Let the next turn of the conversation start. Idempotent; the end of the turn releases it anyway. */
  release(): void;
  /** Whether any earlier turn of the conversation is still running, not only the one just before this one. */
  earlierRunning(): boolean;
  /** Resolves once every earlier turn of the conversation has ended. */
  awaitEarlier: Effect.Effect<void>;
}

export const unqueuedSlot: TurnSlot = {
  release: () => {},
  earlierRunning: () => false,
  awaitEarlier: Effect.void,
};

export interface TurnQueue<T> {
  accept(rec: T): void;
  /** Observation only: production shutdown does not drain channel turns. */
  idle(): Promise<void>;
}

interface Tail {
  fiber: Fiber.Fiber<void>;
  released: Deferred.Deferred<void>;
  ended: boolean;
}

export function createTurnQueue<T extends { conversation: string }>(opts: {
  label: string;
  /** The queue diagnoses escaped failures and closes this turn's resources before its successor runs. */
  run: (rec: T, slot: TurnSlot) => Effect.Effect<void, unknown, Scope.Scope>;
}): TurnQueue<T> {
  const { label, run } = opts;
  /**
   * Each conversation's turns that have not ended, oldest first. A turn can end without waiting for the ones before it (its
   * message was refused, or it was dropped), so what runs before a new turn is every one of these, not just the last.
   */
  const running = new Map<string, Tail[]>();
  return {
    accept(rec) {
      const earlier = [...(running.get(rec.conversation) ?? [])];
      const prev = earlier.at(-1);
      const released = Deferred.makeUnsafe<void>();
      const release = () => void Deferred.doneUnsafe(released, Effect.void);
      const slot: TurnSlot = {
        release,
        earlierRunning: () => earlier.some((tail) => !tail.ended),
        awaitEarlier: Fiber.awaitAll(earlier.map((tail) => tail.fiber)).pipe(Effect.asVoid),
      };
      // Admission counts immediately, including while waiting behind another turn.
      const workDone = beginWork();
      const fiber = Effect.runFork(
        Effect.scoped(
          Effect.gen(function* () {
            // Publish the tail before execution can finish or submit another turn.
            yield* Effect.yieldNow;
            if (prev) yield* Deferred.await(prev.released);
            yield* run(rec, slot);
          }),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() =>
              log.error(
                `${label} turn runner rejected (conversation=${rec.conversation}; own your error surface in run()): ${String(portError(cause))}`,
              ),
            ),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              tail.ended = true;
              release();
              workDone();
              const left = (running.get(rec.conversation) ?? []).filter((other) => other !== tail);
              if (left.length > 0) running.set(rec.conversation, left);
              else running.delete(rec.conversation);
            }),
          ),
        ),
      );
      const tail: Tail = { fiber, released, ended: false };
      running.set(rec.conversation, [...(running.get(rec.conversation) ?? []), tail]);
    },
    idle: () =>
      Effect.runPromise(
        Effect.gen(function* () {
          // A finishing turn may enqueue more work.
          while (running.size > 0) {
            yield* Fiber.awaitAll([...running.values()].flatMap((turns) => turns.map((tail) => tail.fiber)));
          }
        }),
      ),
  };
}
