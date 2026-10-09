/** Scoped acquisition of the two things a pi turn or control write owns: the session lease and the
 *  bound session. The Promise crossing itself is `src/effect-port.ts`. */
import * as Effect from "effect/Effect";
import { port, portCleanup } from "../../effect-port.ts";
import type { PiAgentSessionFactory } from "./invoke-session.ts";
import type { SessionInheritance } from "./session-inheritance.ts";
import type { Lease } from "./turn-kit.ts";
import { beginWork } from "../../channels/busy.ts";

/** Admission was refused: another turn (or another write) holds this session. Its own tag because it
 *  is CONTROL FLOW — a caller answers it with `session_busy` and a retry — not a port failure. */
export class SessionBusy extends Error {
  readonly _tag = "SessionBusy";
  constructor() {
    super("session busy: a turn or another write is already in flight");
  }
}

/**
 * The session lease, held for the scope. Every turn, compaction and control write takes one here, whatever `Lease`
 * the assembly runs on, so a held session is also the process's work in flight (`channels/busy.ts`): what `dev`
 * waits for before it restarts, and what AgentCore's `/ping` reports as busy.
 */
export function acquireSessionLease(lease: Lease, session: string) {
  return Effect.acquireRelease(
    Effect.suspend(() => {
      const release = lease.tryAcquire(session);
      if (!release) return Effect.fail(new SessionBusy());
      const workDone = beginWork();
      return Effect.succeed(() => {
        try {
          release();
        } finally {
          workDone();
        }
      });
    }),
    (release) => portCleanup("lease release", release),
  );
}

export function acquireSession(factory: PiAgentSessionFactory, session: string, inherit?: SessionInheritance) {
  // Acquisition stays uninterruptible: a late factory may still publish durable state under the lease.
  // The extension instances are this session's alone, so their end is its end: pi's `dispose()` does not tell them.
  return Effect.acquireRelease(
    port(() => factory(session, inherit)),
    (bound) =>
      portCleanup("dispose", async () => {
        try {
          await bound.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        } finally {
          bound.dispose();
        }
      }),
  );
}
