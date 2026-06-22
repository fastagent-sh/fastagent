/**
 * Per-session coalesce-to-latest scheduling — this reviewer's trigger semantics.
 *
 * PR review only cares about the LATEST state. So: at most one review in flight per PR, plus a
 * "dirty" flag. A delivery arriving while a review runs sets dirty (it does NOT start a parallel
 * review and is NOT dropped); when the running review finishes, if dirty, exactly one fresh review
 * runs — of the now-latest state, which the agent reads live via `gh`. Result: never parallel,
 * never dropped, never a redundant intermediate review.
 *
 * Scheduling policy is an APP/trigger decision (SPEC §8), not core's — a different trigger might
 * want each-delivery or FIFO. So it lives here, composing core's `BackgroundRunner` (the
 * execution-lifetime port, which still guarantees the work runs to completion).
 */
import type { BackgroundRunner } from "@kid7st/fastagent";

export type Schedule = (session: string, run: () => Promise<void>) => void;

export function coalesceBySession(background: BackgroundRunner): Schedule {
  const active = new Map<string, { dirty: boolean }>();
  return (session, run) => {
    const cur = active.get(session);
    if (cur) {
      cur.dirty = true; // a review is running for this PR → re-review the latest after it finishes
      return;
    }
    const state = { dirty: false };
    active.set(session, state);
    background(async () => {
      try {
        do {
          state.dirty = false;
          await run(); // reviews the LATEST PR state (the agent reads it live via gh)
        } while (state.dirty);
      } finally {
        active.delete(session);
      }
    });
  };
}
