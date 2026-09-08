/** Promise ownership and ACK-independent side-task tracking. Drains are observation hooks, not service shutdown. */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { beginWork } from "../busy.ts";
import { log } from "../../log.ts";

export class TaskFailure extends Error {
  readonly _tag = "TaskFailure";
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

export function taskFailure(cause: Cause.Cause<unknown>): unknown {
  const error = Cause.squash(cause);
  return error instanceof TaskFailure ? error.cause : error;
}

/** These ports expose no abort hook. Interruption must join their actual work before releasing ownership. */
export function taskEffect<A>(run: () => Promise<A>): Effect.Effect<A, TaskFailure> {
  const wait = (pending: Promise<A>) =>
    Effect.tryPromise({ try: () => pending, catch: (cause) => new TaskFailure(cause) });
  return Effect.acquireUseRelease(
    Effect.try({ try: run, catch: (cause) => new TaskFailure(cause) }),
    wait,
    (pending, exit) => (Exit.hasInterrupts(exit) ? Effect.exit(wait(pending)) : Effect.void),
  );
}

export function runTask<A>(work: Effect.Effect<A, TaskFailure>): Promise<A> {
  return Effect.runPromise(work.pipe(Effect.mapError((error) => error.cause)));
}

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
        taskEffect(() => task).pipe(
          Effect.asVoid,
          Effect.catchCause((cause) =>
            Effect.sync(() => log.warn(`${label} side task rejected: ${String(taskFailure(cause))}`)),
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
