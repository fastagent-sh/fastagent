/** Scoped outbound writers. Frames coalesce; native append/status operations retain every queued write. */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { AgentEvent } from "../../agent.ts";
import { log } from "../../log.ts";
import type { ChannelFailure } from "./preview-kit.ts";
import { TaskFailure, taskEffect } from "./tasks.ts";

/** Snapshot/edit renderers share terminal ownership; platform-specific settle policies stay injected. */
export function renderReply(
  events: Stream.Stream<AgentEvent, TaskFailure>,
  opts: {
    label: string;
    onEvent: (event: AgentEvent) => void;
    finish: Effect.Effect<void>;
    answer: () => string;
    settle: (text: string) => Effect.Effect<void, TaskFailure>;
    formatError: (failure: ChannelFailure) => string | undefined;
  },
): Effect.Effect<void, TaskFailure, Scope.Scope> {
  return Effect.gen(function* () {
    let finalized = false;
    const notify = (failure: ChannelFailure, phase: string) =>
      Effect.try({ try: () => opts.formatError(failure) ?? "", catch: (cause) => new TaskFailure(cause) }).pipe(
        Effect.flatMap(opts.settle),
        Effect.catchTag("TaskFailure", (error) =>
          Effect.sync(() => log.error(`${opts.label} failed to deliver the ${phase} notice: ${String(error.cause)}`)),
        ),
      );
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* opts.finish;
        if (!finalized)
          yield* notify({ details: "the turn ended without completing", retryable: false }, "abnormal-turn");
      }),
    );
    yield* Stream.runForEachWhile(events, (event) => {
      if (event.type !== "completed" && event.type !== "failed") {
        return Effect.try({
          try: () => {
            opts.onEvent(event);
            return true;
          },
          catch: (cause) => new TaskFailure(cause),
        });
      }
      return Effect.gen(function* () {
        yield* opts.finish;
        finalized = true;
        if (event.type === "completed") {
          yield* opts.settle(opts.answer());
        } else {
          yield* notify(
            {
              details: event.details,
              retryable: event.retryable,
              ...(event.code !== undefined ? { code: event.code } : {}),
            },
            "agent-failure",
          );
          return yield* Effect.fail(
            new TaskFailure(new Error(`agent failed: ${event.details} (retryable=${event.retryable})`)),
          );
        }
        return false;
      }).pipe(Effect.uninterruptible);
    });
    if (!finalized) yield* Effect.fail(new TaskFailure(new Error("stream ended without a terminal event")));
  });
}

export interface PreviewPump {
  touch(): void;
  /** Cancel pacing, join an issued write, and prevent any subsequent frame. */
  finish: Effect.Effect<void>;
}

export function previewPump(opts: {
  flush: () => Promise<void>;
  throttleMs: number;
  /** Slack's mutation slot precedes a write; stopping the pump can discard this pending frame. */
  beforeFlush?: Effect.Effect<void>;
  onError: (error: unknown) => void;
}): Effect.Effect<PreviewPump, never, Scope.Scope> {
  return Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const run = Effect.runSyncWith(yield* Effect.context<never>());
    let fiber: Fiber.Fiber<void> | undefined;
    let stopped = false;
    let dirty = false;
    let reported = false;
    const work = Effect.gen(function* () {
      while (dirty && !stopped) {
        dirty = false;
        if (opts.beforeFlush) yield* opts.beforeFlush;
        // An issued mutation may have reached the platform. Join it, including publishing its id
        // and diagnosing its outcome, before the final writer takes over.
        yield* taskEffect(opts.flush).pipe(
          Effect.catchTag("TaskFailure", (error) =>
            Effect.sync(() => {
              if (!reported) {
                reported = true;
                opts.onError(error.cause);
              }
            }),
          ),
          Effect.uninterruptible,
        );
        if (dirty && !stopped) yield* Effect.sleep(opts.throttleMs);
      }
    });
    const finish = Effect.gen(function* () {
      stopped = true;
      if (!fiber) return;
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) yield* Effect.failCause(exit.cause);
    });
    yield* Effect.addFinalizer(() => finish);
    return {
      touch: () => {
        if (stopped) return;
        dirty = true;
        const exit = fiber?.pollUnsafe();
        if (fiber && (!exit || Exit.isFailure(exit))) return;
        // The first placeholder starts before a fast source can reach its terminal event.
        fiber = run(Effect.forkIn(work, scope, { startImmediately: true }));
      },
      finish,
    };
  });
}

export interface SerialWriter {
  enqueue(work: () => Promise<void>): void;
  /** End admission and join every accepted operation, including its caller-owned failure policy. */
  finish: Effect.Effect<void, TaskFailure>;
}

export function serialWriter(): Effect.Effect<SerialWriter, never, Scope.Scope> {
  return Effect.gen(function* () {
    const queue = yield* Queue.unbounded<() => Promise<void>, Cause.Done>();
    const work = Effect.gen(function* () {
      for (;;) {
        const next = yield* Queue.take(queue);
        yield* taskEffect(next).pipe(Effect.uninterruptible);
      }
    }).pipe(Effect.catchTag("Done", () => Effect.void));
    const fiber = yield* Effect.forkScoped(work);
    const finish = Effect.sync(() => {
      Queue.endUnsafe(queue);
    }).pipe(Effect.andThen(Fiber.join(fiber)));
    // This finalizer precedes forkScoped's interruption: accepted append/status writes must drain.
    yield* Effect.addFinalizer(() => finish.pipe(Effect.orDie));
    return {
      enqueue: (next) => {
        if (!Queue.offerUnsafe(queue, next)) throw new Error("delivery writer is closed");
      },
      finish,
    };
  });
}
