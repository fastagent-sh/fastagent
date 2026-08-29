/**
 * SHARED fire-and-forget side-task tracking. Channels launch work off the request path (stop
 * feedback, DM welcomes) that must not block the transport ACK but MUST be drained on shutdown
 * (`turnsIdle`) — otherwise a reply in flight when the process exits is silently dropped. Error
 * handling stays with the caller: track() only guarantees the drain sees the task SETTLE, and settle
 * includes reject. A caller that handles its error on a separate branch (`p.catch(log); track(p)`)
 * still hands us a promise that rejects, and a drain that propagated it would turn one channel's side
 * task into a failed `turnsIdle` for the whole serve.
 */
import { beginWork } from "../busy.ts";

export interface TaskTracker {
  /** Track one task. The caller keeps its own `.catch` — rejections must already be handled. */
  track(task: Promise<unknown>): void;
  /** Resolves when every currently-tracked task has settled. */
  drain(): Promise<void>;
}

export function createTaskTracker(): TaskTracker {
  const tasks = new Set<Promise<unknown>>();
  return {
    track(task) {
      tasks.add(task);
      // Tracked side tasks count as process-wide in-flight work (busy.ts) — same signal the turn
      // queue reports, read by serving surfaces that must not idle while background work runs.
      const workDone = beginWork();
      void task
        .finally(() => {
          workDone();
          tasks.delete(task);
        })
        .catch(() => {}); // the caller's chain owns the error
    },
    drain: () => Promise.allSettled(tasks).then(() => undefined),
  };
}
