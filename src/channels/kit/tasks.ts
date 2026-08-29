/**
 * SHARED fire-and-forget side-task tracking. Channels launch work off the request path (stop
 * feedback, DM welcomes) that must not block the transport ACK but MUST be drained on shutdown
 * (`turnsIdle`) — otherwise a reply in flight when the process exits is silently dropped. Error
 * handling stays with the caller: track() only guarantees the drain sees the task SETTLE, and settle
 * includes reject. A caller that handles its error on a separate branch (`p.catch(log); track(p)`)
 * still hands us a promise that rejects, and a drain that propagated it would fail the channel's whole
 * `turnsIdle` over one side task. A rejection that reaches us is logged — we
 * cannot tell a missing `.catch` from one on a separate branch, so the line is a visibility floor
 * rather than a diagnosis, and without it a dropped side task leaves no trace anywhere.
 */
import { beginWork } from "../busy.ts";
import { log } from "../../log.ts";

export interface TaskTracker {
  /** Track one task. The caller keeps its own `.catch` — rejections must already be handled. */
  track(task: Promise<unknown>): void;
  /** Resolves when every currently-tracked task has settled. */
  drain(): Promise<void>;
}

export function createTaskTracker(label: string): TaskTracker {
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
        .catch((error) => log.warn(`${label} side task rejected: ${String(error)}`));
    },
    drain: () => Promise.allSettled(tasks).then(() => undefined),
  };
}
