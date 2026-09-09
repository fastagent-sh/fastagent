/** ACK-independent side-task tracking. Drains are observation hooks, not service shutdown. */
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { portError, portJoin } from "../../effect-port.ts";
import { beginWork } from "../busy.ts";
import { log } from "../../log.ts";

export interface TaskTracker {
  /** Track already-started work. Rejections are logged without failing the drain. */
  track(task: Promise<unknown>): void;
  /** Resolves when every currently-tracked task has settled. */
  drain(): Promise<void>;
}

export function createTaskTracker(label: string): TaskTracker {
  const tasks = new Set<Fiber.Fiber<void>>();
  return {
    track(task) {
      const workDone = beginWork();
      const fiber = Effect.runFork(
        portJoin(() => task).pipe(
          Effect.asVoid,
          Effect.catchCause((cause) =>
            Effect.sync(() => log.warn(`${label} side task rejected: ${String(portError(cause))}`)),
          ),
          Effect.ensuring(Effect.sync(workDone)),
        ),
      );
      tasks.add(fiber);
      fiber.addObserver(() => tasks.delete(fiber));
    },
    drain: () => Effect.runPromise(Effect.asVoid(Fiber.awaitAll([...tasks]))),
  };
}
