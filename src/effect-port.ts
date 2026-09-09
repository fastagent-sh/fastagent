/**
 * The ONE crossing between this codebase's Promise-shaped ports and Effect execution.
 *
 * The ports are everywhere and none of them are ours to change: the SPEC fixes `Agent.invoke` as an
 * AsyncIterable and `SessionControl` as Promises, pi's SDK is Promise-based, every platform client
 * is `fetch`, and so is the filesystem. Two properties have to hold at each crossing:
 *
 *  1. INTERRUPTION MUST JOIN. A Promise exposes no abort hook, so cancelling the fiber that awaits
 *     one does not stop the work behind it. Releasing its resources anyway is how a disposed session
 *     gets written to, or a lease is handed to the next turn while the previous one is still
 *     running. {@link portJoin}, {@link portAbort} and {@link portRequest} therefore wait for the
 *     pending promise to settle before releasing, and abort first when the port gives us a door.
 *     {@link port} is the explicit opt-out, for work a caller may walk away from — so a call site
 *     holding a lease, a session or any other resource must not reach for it.
 *  2. THE CAUSE SURVIVES. Retry classification (`turn-kit.classifyRetryable`), the channels'
 *     platform error types and every operator-facing message read the ORIGINAL error, so the
 *     wrapper carries it verbatim and {@link portError} is how a caller gets it back.
 *
 * Both were re-derived per module during the Effect migration: the channel kit, the pi engine, the
 * AgentCore runtime and the scheduler each grew a tagged error, a squash-unwrapper and a
 * join-on-interrupt combinator that differed only in the word in front of `Failure`. Four copies of
 * one piece of knowledge, and the next module would have made five.
 *
 * What is NOT here is a policy: whether a failure rejects a request, is logged, or ends a turn stays
 * with the caller that knows. The only opinion this module holds is the one above.
 */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { log } from "./log.ts";

/** A Promise port's failure, carrying the original error as `cause`. One tag, because every caller
 *  that discriminates does so on WHAT FAILED (its own control flow), never on which module wrapped
 *  it — the four tags this replaced were never told apart by anyone. */
export class PortFailure extends Error {
  readonly _tag = "PortFailure";
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

/** The original error behind a failed port, for classification and messages. */
export function portError(cause: Cause.Cause<unknown>): unknown {
  const error = Cause.squash(cause);
  return error instanceof PortFailure ? error.cause : error;
}

/** Await a promise we already own, as a typed failure. */
const wait = <A>(pending: Promise<A>): Effect.Effect<A, PortFailure> =>
  Effect.tryPromise({ try: () => pending, catch: (cause) => new PortFailure(cause) });

/** A Promise port whose work is abandonable: interruption does not wait for it. Use for reads and
 *  for writes a caller is free to walk away from; anything holding a resource wants {@link portJoin}. */
export function port<A>(run: () => Promise<A>): Effect.Effect<A, PortFailure> {
  return Effect.tryPromise({ try: run, catch: (cause) => new PortFailure(cause) });
}

/** A Promise port with no abort hook: interruption joins the issued work before releasing. */
export function portJoin<A>(run: () => Promise<A>): Effect.Effect<A, PortFailure> {
  return Effect.acquireUseRelease(
    Effect.try({ try: run, catch: (cause) => new PortFailure(cause) }),
    wait,
    (pending, exit) => (Exit.hasInterrupts(exit) ? Effect.exit(wait(pending)) : Effect.void),
  );
}

/** A Promise port WITH an abort hook: interruption stops the work, then joins it. The hook runs only
 *  on interruption — a settled operation must not be told to abort (`session.abort()` on a finished
 *  run would reach the next one). A failing hook is diagnosed, never rethrown, under `label`: the
 *  tag is one thing, but a serve running an invoke and a manual compaction at once needs the warn to
 *  say WHICH abort could not be delivered. */
export function portAbort<A>(
  label: string,
  run: () => Promise<A>,
  abort: () => void | Promise<void>,
): Effect.Effect<A, PortFailure> {
  return Effect.acquireUseRelease(
    Effect.try({ try: run, catch: (cause) => new PortFailure(cause) }),
    wait,
    (pending, exit) =>
      Exit.hasInterrupts(exit)
        ? portCleanup(`${label} abort`, abort).pipe(
            // Cancellation silences the port's result, but its work must settle before release.
            Effect.andThen(Effect.exit(wait(pending))),
          )
        : Effect.void,
  );
}

/** A request with a deadline: the signal is closed on EVERY exit (it owns the response body, which a
 *  settled call has to release too), and the real request is joined before ownership is given up. */
export function portRequest<A>(
  run: (signal: AbortSignal) => Promise<A>,
  timeoutMs: number,
): Effect.Effect<A, PortFailure> {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const controller = new AbortController();
      // Publish the controller before entering foreign code, including a synchronous fetch throw.
      return { controller, pending: Promise.resolve().then(() => run(controller.signal)) };
    }),
    ({ pending }) =>
      wait(pending).pipe(
        Effect.timeout(timeoutMs),
        Effect.mapError((error) => (error instanceof PortFailure ? error : new PortFailure(error))),
      ),
    ({ controller, pending }) => Effect.sync(() => controller.abort()).pipe(Effect.andThen(Effect.exit(wait(pending)))),
  );
}

/** Cleanup anomalies are diagnostic: they cannot change an already-published outcome. */
export function portCleanup(operation: string, run: () => void | Promise<void>): Effect.Effect<void> {
  return port(async () => run()).pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => log.warn(`[fastagent] ${operation} failed during cleanup: ${String(portError(cause))}`)),
    ),
  );
}
