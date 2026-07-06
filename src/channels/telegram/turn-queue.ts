/**
 * Per-session serial turn execution: one turn at a time per session (FIFO chains), different
 * sessions concurrent. IN-MEMORY — the runtime queue holds no durability of its own. The engine lease
 * is the corruption floor beneath this; this adds the group-UX queue (a second summon waits its turn
 * instead of colliding on the lease and being dropped as "busy").
 *
 * Channel-neutral (records are opaque beyond a `session` key); it lives in the telegram directory
 * because that is its only consumer today. Durability is layered ON TOP by the caller: turn-store.ts
 * persists an accepted turn's intent pre-ACK and replays a crash-surviving one on the next start (L1,
 * process-crash recovery, at-least-once). Exactly-once / deterministic step-replay (L2) is the K-axis
 * backend — an external queue with distributed locking (SPEC §11) — not this in-memory queue.
 */
import { log } from "../../log.ts";

export interface TurnQueue<T> {
  /** Schedule onto the session's serial chain (runs after that session's previous turn). */
  accept(rec: T): void;
}

export function createTurnQueue<T extends { session: string }>(opts: {
  /** Log prefix naming the consumer (e.g. "[telegram]") — the queue itself is channel-neutral. */
  label: string;
  /** Executes ONE turn. The queue wraps it: dequeue in FIFO order per session. The runner owns its
   *  own error surface; a rejection that escapes anyway is caught and logged here (never a silent
   *  unhandled rejection), but the runner's own catch is where diagnosis belongs. */
  run: (rec: T) => Promise<void>;
  /** Fired synchronously when a record is scheduled BEHIND an active turn — the caller's hook for
   *  queue feedback to the user (e.g. an "⏳ queued" notice). */
  onQueuedBehind?: (rec: T) => void;
}): TurnQueue<T> {
  const { label, run, onQueuedBehind } = opts;

  // Per-session serial chains: a second turn for the same session waits its turn (FIFO) instead of
  // colliding on the engine lease and being dropped as "busy". Different sessions run concurrently.
  const chains = new Map<string, Promise<void>>();

  return {
    accept(rec) {
      if (chains.has(rec.session)) onQueuedBehind?.(rec);
      const prev = chains.get(rec.session) ?? Promise.resolve();
      const task = async (): Promise<void> => {
        try {
          await run(rec);
        } catch (e) {
          log.error(
            `${label} turn runner rejected (session=${rec.session}; own your error surface in run()): ${String(e)}`,
          );
        }
      };
      const next = prev.then(task, task); // run after this session's previous turn, in arrival order
      chains.set(rec.session, next);
      void next.finally(() => {
        if (chains.get(rec.session) === next) chains.delete(rec.session); // drop the entry when drained
      });
    },
  };
}
