/** Own an Agent's AsyncIterable inside a typed, demand-driven channel stream. */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { log } from "../../log.ts";
import { PortFailure } from "../../effect-port.ts";

/** Acquire lazily; interruption closes the source, while natural exhaustion needs no extra return. */
export function eventStream<A>(
  open: () => AsyncIterable<A>,
  label: string,
): Stream.Stream<A, PortFailure, Scope.Scope> {
  return Stream.fromPull(
    Effect.gen(function* () {
      let exhausted = false;
      const iterator = yield* Effect.acquireRelease(
        Effect.try({ try: () => open()[Symbol.asyncIterator](), catch: (cause) => new PortFailure(cause) }),
        (iterator) => {
          const close = iterator.return?.bind(iterator);
          if (!close || exhausted) return Effect.void;
          return Effect.promise(close).pipe(
            Effect.onError((cause) =>
              Effect.sync(() => log.warn(`${label} source cleanup failed: ${String(Cause.squash(cause))}`)),
            ),
          );
        },
      );
      return Effect.gen(function* () {
        const result = yield* Effect.tryPromise({
          try: () => iterator.next(),
          catch: (cause) => new PortFailure(cause),
        });
        if (result.done) {
          exhausted = true;
          return yield* Cause.done();
        }
        return [result.value] as const;
      });
    }),
  );
}
