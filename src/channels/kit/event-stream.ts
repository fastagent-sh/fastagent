/** Promise/AsyncIterable adapters for internal channel streams. Public errors retain their original identity. */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { cancellableStream } from "../../collect.ts";
import { log } from "../../log.ts";
import { TaskFailure } from "./tasks.ts";

/** Acquire lazily; match for-await's natural exhaustion and abort-first return behavior. */
export function eventStream<A>(
  open: () => AsyncIterable<A>,
  label: string,
): Stream.Stream<A, TaskFailure, Scope.Scope> {
  return Stream.fromPull(
    Effect.gen(function* () {
      let exhausted = false;
      const iterator = yield* Effect.acquireRelease(
        Effect.try({ try: () => open()[Symbol.asyncIterator](), catch: (cause) => new TaskFailure(cause) }),
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
          catch: (cause) => new TaskFailure(cause),
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

export function toEvents<A>(stream: Stream.Stream<A, TaskFailure>): AsyncIterable<A> {
  return cancellableStream(async function* ({ onCancelReady }) {
    const iterator = Stream.toAsyncIterable(stream.pipe(Stream.mapError((error) => error.cause)))[
      Symbol.asyncIterator
    ]() as Required<AsyncIterator<A>>;
    let closing: Promise<IteratorResult<A>> | undefined;
    onCancelReady(() => {
      closing = iterator.return();
    });
    try {
      for (;;) {
        const result = await iterator.next();
        if (result.done) return;
        yield result.value;
      }
    } finally {
      await (closing ?? iterator.return());
    }
  });
}
