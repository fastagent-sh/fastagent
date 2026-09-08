/** AgentCore's IO ownership; callers choose whether a failure rejects a request or is diagnosed. */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

export class AgentcoreFailure extends Error {
  readonly _tag = "AgentcoreFailure";
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

export function agentcoreFailure(cause: Cause.Cause<unknown>): unknown {
  const error = Cause.squash(cause);
  return error instanceof AgentcoreFailure ? error.cause : error;
}

/** Filesystem/activation ports expose no abort hook; their owner must join issued work. */
export function agentcoreOperation<A>(run: () => Promise<A>): Effect.Effect<A, AgentcoreFailure> {
  return Effect.tryPromise({ try: run, catch: (cause) => new AgentcoreFailure(cause) }).pipe(Effect.uninterruptible);
}

/** A deadline aborts the real request and joins it before busy ownership or a retry can proceed. */
export function agentcoreRequest<A>(
  run: (signal: AbortSignal) => Promise<A>,
  timeoutMs: number,
): Effect.Effect<A, AgentcoreFailure> {
  const wait = (pending: Promise<A>) =>
    Effect.tryPromise({ try: () => pending, catch: (cause) => new AgentcoreFailure(cause) });
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const controller = new AbortController();
      // Publish the controller before entering foreign code, including a synchronous fetch throw.
      return { controller, pending: Promise.resolve().then(() => run(controller.signal)) };
    }),
    ({ pending }) =>
      wait(pending).pipe(
        Effect.timeout(timeoutMs),
        Effect.mapError((error) => (error instanceof AgentcoreFailure ? error : new AgentcoreFailure(error))),
      ),
    ({ controller, pending }) => Effect.sync(() => controller.abort()).pipe(Effect.andThen(Effect.exit(wait(pending)))),
  );
}
