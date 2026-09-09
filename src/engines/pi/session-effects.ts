/** Scoped acquisition of the two things a pi turn or control write owns: the session lease and the
 *  bound session. The Promise crossing itself is `src/effect-port.ts`. */
import * as Effect from "effect/Effect";
import { port, portCleanup } from "../../effect-port.ts";
import type { PiAgentSessionFactory } from "./invoke-session.ts";
import type { SessionInheritance } from "./session-inheritance.ts";
import type { Lease } from "./turn-kit.ts";

/** Admission was refused: another turn (or another write) holds this session. Its own tag because it
 *  is CONTROL FLOW — a caller answers it with `session_busy` and a retry — not a port failure. */
export class SessionBusy extends Error {
  readonly _tag = "SessionBusy";
  constructor() {
    super("session busy: a turn or another write is already in flight");
  }
}

export function acquireSessionLease(lease: Lease, session: string) {
  return Effect.acquireRelease(
    Effect.suspend(() => {
      const release = lease.tryAcquire(session);
      return release ? Effect.succeed(release) : Effect.fail(new SessionBusy());
    }),
    (release) => portCleanup("lease release", release),
  );
}

export function acquireSession(factory: PiAgentSessionFactory, session: string, inherit?: SessionInheritance) {
  // Acquisition stays uninterruptible: a late factory may still publish durable state under the lease.
  // Disposal must not emit session_shutdown: extension instances belong to the shared assembly.
  return Effect.acquireRelease(
    port(() => factory(session, inherit)),
    (bound) => portCleanup("dispose", () => bound.dispose()),
  );
}
