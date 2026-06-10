/**
 * Single-writer lease: at most one in-flight turn per session (the concurrency side
 * of SPEC portable conformance).
 *
 * **Contention policy = fail-fast, no queueing**: when already held, `tryAcquire`
 * returns null and the caller emits `failed{retryable:true}` ("session busy").
 * This is a corruption-prevention floor only — it does not pick a UX for any
 * scenario: dedupe / queueing / steering are channel/upper-layer decisions
 * (they know the trigger semantics).
 *
 * Why not queue: real same-session concurrency is mostly "duplicate intent"
 * (dedupe) or "single user firing follow-ups" (steering), not "two real turns";
 * FIFO serialization fits only the multi-participant case, and introduces an
 * unbounded queue plus a slot-leak deadlock when a queued waiter is cancelled.
 *
 * Synchronous, no awaits: nothing interleaves between acquire and entering try,
 * so cancellation at any point still releases in finally — no deadlock class.
 * Cross-process/multi-instance distributed locking (TTL + fencing) is a separate
 * future interface, not this one.
 */
export type Release = () => void;

export interface Lease {
  /** Try to acquire exclusive write access for the session (fail-fast). Returns null if held. */
  tryAcquire(session: string): Release | null;
}

/** In-process single-writer: a per-session occupancy set. */
export function inProcessLease(): Lease {
  const busy = new Set<string>();
  return {
    tryAcquire(session: string): Release | null {
      if (busy.has(session)) return null;
      busy.add(session);
      let released = false;
      return () => {
        if (released) return; // idempotent
        released = true;
        busy.delete(session);
      };
    },
  };
}
