/**
 * Work that runs at most once per process, whose outcome every caller shares, success or failure.
 *
 * `Effect.cached` is not that in effect 4.0.x: it interrupts a run once every caller has left it, and a run that
 * finishes anyway (uninterruptible) is not cached, so the next caller starts the work a second time; and a call made
 * while its run is still starting joins a fiber that is not assigned yet and dies.
 */
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

/**
 * The first call runs `work` to the end, uninterruptibly; every call, the first included, then reads its one outcome.
 * A call made while the work is running, including one the work itself causes, waits for it.
 */
export function once<A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  const outcome = Deferred.makeUnsafe<A, E>();
  let started = false;
  return Effect.suspend(() => {
    if (started) return Deferred.await(outcome);
    started = true;
    return work.pipe(
      Effect.exit,
      Effect.flatMap((exit) => Deferred.done(outcome, exit)),
      Effect.uninterruptible,
      Effect.andThen(Deferred.await(outcome)),
    );
  });
}
