/** Shared execution boundaries for invocation and control-plane writes. Public ports stay Promise-based. */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { log } from "../../log.ts";
import type { PiAgentSessionFactory } from "./invoke-session.ts";
import type { SessionInheritance } from "./session-inheritance.ts";
import type { Lease } from "./turn-kit.ts";

export class SessionBusy extends Error {
  readonly _tag = "SessionBusy";
  constructor() {
    super("session busy: a turn or another write is already in flight");
  }
}

export class SessionOperationError extends Error {
  readonly _tag = "SessionOperationError";
  readonly operation: string;
  constructor(operation: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.operation = operation;
  }
}

/** Keep foreign error metadata intact for protocol retry classification. */
export function sessionFailure(cause: Cause.Cause<unknown>): unknown {
  const error = Cause.squash(cause);
  return error instanceof SessionOperationError ? error.cause : error;
}

export function sessionOperation<A>(operation: string, run: () => Promise<A>): Effect.Effect<A, SessionOperationError> {
  return Effect.tryPromise({ try: run, catch: (cause) => new SessionOperationError(operation, cause) });
}

/** Cleanup anomalies are diagnostic; they cannot change an already-published operation outcome. */
export function sessionCleanup(operation: string, run: () => void | Promise<void>): Effect.Effect<void> {
  return sessionOperation(operation, async () => run()).pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() =>
        log.warn(`[fastagent] session ${operation} failed during cleanup: ${String(sessionFailure(cause))}`),
      ),
    ),
  );
}

export function acquireSessionLease(lease: Lease, session: string) {
  return Effect.acquireRelease(
    Effect.suspend(() => {
      const release = lease.tryAcquire(session);
      return release ? Effect.succeed(release) : Effect.fail(new SessionBusy());
    }),
    (release) => sessionCleanup("lease release", release),
  );
}

export function acquireSession(factory: PiAgentSessionFactory, session: string, inherit?: SessionInheritance) {
  // Acquisition stays uninterruptible: a late factory may still publish durable state under the lease.
  // Disposal must not emit session_shutdown: extension instances belong to the shared assembly.
  return Effect.acquireRelease(
    sessionOperation("open", () => factory(session, inherit)),
    (bound) => sessionCleanup("dispose", () => bound.dispose()),
  );
}

/** Interrupting a Promise wait must also abort and join the SDK operation before resources are released. */
export function sessionWork<A>(
  operation: string,
  run: () => Promise<A>,
  abort: () => void | Promise<void>,
): Effect.Effect<A, SessionOperationError> {
  return Effect.acquireUseRelease(
    Effect.try({ try: run, catch: (cause) => new SessionOperationError(operation, cause) }),
    (pending) => sessionOperation(operation, () => pending),
    (pending, exit) =>
      Exit.hasInterrupts(exit)
        ? sessionCleanup(`${operation} abort`, abort).pipe(
            // Cancellation silences the SDK result, but its work must settle before release.
            Effect.andThen(Effect.exit(sessionOperation(operation, () => pending))),
          )
        : Effect.void,
  );
}
