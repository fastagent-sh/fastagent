/**
 * Where Effect code calls Promise code it does not own: pi's SDK, the MCP SDK, platform clients over `fetch`, and the
 * filesystem. Two rules hold at every such call:
 *
 *  1. INTERRUPTION JOINS. A Promise has no abort hook, so interrupting the fiber that awaits one does not stop the
 *     work behind it. Releasing its resources anyway is how a disposed session gets written to, or a lease is handed
 *     to the next turn while the previous one is still running. {@link joinPromise}, {@link abortThenJoin} and
 *     {@link requestWithDeadline} wait for the pending promise to settle before releasing, aborting first when the
 *     callee takes a signal. {@link fromPromise} is the opt-out for work a caller may walk away from, so a call site
 *     holding a lease, a session or any other resource must not use it.
 *  2. THE CAUSE SURVIVES. Retry classification (`messages.ts` `thrownFailure`), the channels' platform error types
 *     and every operator-facing message read the original error, so {@link PromiseFailure} carries it verbatim and
 *     {@link originalError} returns it. Effect's own `tryPromise` maps to `UnknownError` and does not join.
 *
 * Policy stays with the caller: whether a failure rejects a request, is logged, or ends a turn.
 */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { log } from "./log.ts";

/** A failed promise, carrying the original error as `cause`. One tag, because every caller
 *  that discriminates does so on WHAT FAILED (its own control flow), never on which module wrapped it. */
export class PromiseFailure extends Error {
  readonly _tag = "PromiseFailure";
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

/** The original error behind a failed promise, for classification and messages. */
export function originalError(cause: Cause.Cause<unknown>): unknown {
  const error = Cause.squash(cause);
  return error instanceof PromiseFailure ? error.cause : error;
}

/** Await a promise we already own, as a typed failure. */
const wait = <A>(pending: Promise<A>): Effect.Effect<A, PromiseFailure> =>
  Effect.tryPromise({ try: () => pending, catch: (cause) => new PromiseFailure(cause) });

/** A promise whose work is abandonable: interruption does not wait for it. Use for reads and
 *  for writes a caller is free to walk away from; anything holding a resource wants {@link joinPromise}. */
export function fromPromise<A>(run: () => Promise<A>): Effect.Effect<A, PromiseFailure> {
  return Effect.tryPromise({ try: run, catch: (cause) => new PromiseFailure(cause) });
}

/** A promise with no abort hook: interruption joins the issued work before releasing. */
export function joinPromise<A>(run: () => Promise<A>): Effect.Effect<A, PromiseFailure> {
  return Effect.acquireUseRelease(
    Effect.try({ try: run, catch: (cause) => new PromiseFailure(cause) }),
    wait,
    (pending, exit) => (Exit.hasInterrupts(exit) ? Effect.exit(wait(pending)) : Effect.void),
  );
}

/** A promise WITH an abort hook: interruption stops the work, then joins it. The hook runs only
 *  on interruption — a settled operation must not be told to abort (`session.abort()` on a finished
 *  run would reach the next one). A failing hook is diagnosed, never rethrown, under `label`: the
 *  tag is one thing, but a serve running an invoke and a manual compaction at once needs the warn to
 *  say WHICH abort could not be delivered. */
export function abortThenJoin<A>(
  label: string,
  run: () => Promise<A>,
  abort: () => void | Promise<void>,
): Effect.Effect<A, PromiseFailure> {
  return Effect.acquireUseRelease(
    Effect.try({ try: run, catch: (cause) => new PromiseFailure(cause) }),
    wait,
    (pending, exit) =>
      Exit.hasInterrupts(exit)
        ? cleanupQuietly(`${label} abort`, abort).pipe(
            // Cancellation silences the promise's result, but its work must settle before release.
            Effect.andThen(Effect.exit(wait(pending))),
          )
        : Effect.void,
  );
}

/** A request with a deadline: the signal is closed on EVERY exit (it owns the response body, which a
 *  settled call has to release too), and the real request is joined before ownership is given up. */
export function requestWithDeadline<A>(
  run: (signal: AbortSignal) => Promise<A>,
  timeoutMs: number,
): Effect.Effect<A, PromiseFailure> {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const controller = new AbortController();
      // Publish the controller before entering foreign code, including a synchronous fetch throw.
      return { controller, pending: Promise.resolve().then(() => run(controller.signal)) };
    }),
    ({ pending }) =>
      wait(pending).pipe(
        Effect.timeout(timeoutMs),
        Effect.mapError((error) => (error instanceof PromiseFailure ? error : new PromiseFailure(error))),
      ),
    ({ controller, pending }) => Effect.sync(() => controller.abort()).pipe(Effect.andThen(Effect.exit(wait(pending)))),
  );
}

/** Cleanup anomalies are diagnostic: they cannot change an already-published outcome. */
export function cleanupQuietly(operation: string, run: () => void | Promise<void>): Effect.Effect<void> {
  return fromPromise(async () => run()).pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => log.warn(`[fastagent] ${operation} failed during cleanup: ${String(originalError(cause))}`)),
    ),
  );
}
