/**
 * SHARED fire-and-forget side-task tracking. Channels launch work off the request path (stop
 * feedback, DM welcomes) that must not block the transport ACK but MUST be drained on shutdown
 * (`turnsIdle`) — otherwise a reply in flight when the process exits is silently dropped. Error
 * handling stays with the caller: track() only guarantees the drain sees the task settle.
 */
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
      void task.finally(() => tasks.delete(task)).catch(() => {}); // the caller's chain owns the error
    },
    drain: () => Promise.all(tasks).then(() => undefined),
  };
}
