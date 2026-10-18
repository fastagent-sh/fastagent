/** Scoped outbound writers. Frames coalesce; native append/status operations retain every queued write. */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { InvokeEvent } from "../../protocol.ts";
import { log } from "../../log.ts";
import type { ChannelFailure } from "./preview-kit.ts";
import { PortFailure, portJoin } from "../../effect-port.ts";

/** How a turn ended: answered, or the failure to tell the asker about. */
export type TurnEnd = { answered: true } | { failure: ChannelFailure };

/**
 * Whether this event ends the turn, and how: the invoke refused (nothing ran), or the turn's message ended. A message
 * whose work stopped at its output limit, or that a command took, still answers with what was written.
 */
export function turnEnd(event: InvokeEvent, messageId: string | undefined): TurnEnd | undefined {
  if (event.type === "rejected") {
    const { code, message, retryable } = event.error;
    return { failure: { details: message, retryable, code } };
  }
  if (event.type !== "done" || event.message.messageId !== messageId) return undefined;
  const { outcome } = event.message;
  switch (outcome.status) {
    case "completed":
    case "max_tokens":
    case "intercepted":
      return { answered: true };
    case "failed":
      return {
        failure: { details: outcome.error.message, retryable: outcome.error.retryable, code: outcome.error.code },
      };
    case "canceled":
      return { failure: { details: `the work was canceled (${outcome.by})`, retryable: false, code: "canceled" } };
    case "interrupted":
      return { failure: { details: "the work was interrupted", retryable: true, code: "interrupted" } };
  }
}

/**
 * A turn whose stream ended before its message did, after the agent said why (`serving_error`: the message's end could
 * not be recorded, or missed events could not be read back): a failure worth trying again. Undefined when nothing was said.
 */
export function unfinishedTurn(servingError: string | undefined): ChannelFailure | undefined {
  return servingError === undefined ? undefined : { details: servingError, retryable: true, code: "serving_error" };
}

/** Snapshot/edit renderers share terminal ownership; platform-specific settle policies stay injected. */
export function renderReply(
  events: Stream.Stream<InvokeEvent, PortFailure>,
  opts: {
    label: string;
    onEvent: (event: InvokeEvent) => void;
    finish: Effect.Effect<void>;
    answer: () => string;
    settle: (text: string) => Effect.Effect<void, PortFailure>;
    formatError: (failure: ChannelFailure) => string | undefined;
    /** The finished reply, handed over before it is delivered — where a channel records it for recovery. */
    onAnswered?: (answer: string) => void;
  },
): Effect.Effect<void, PortFailure, Scope.Scope> {
  return Effect.gen(function* () {
    let finalized = false;
    const notify = (failure: ChannelFailure, phase: string) =>
      Effect.try({ try: () => opts.formatError(failure) ?? "", catch: (cause) => new PortFailure(cause) }).pipe(
        Effect.flatMap(opts.settle),
        Effect.catchTag("PortFailure", (error) =>
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
    let messageId: string | undefined;
    let servingError: string | undefined;
    const failWith = (failure: ChannelFailure) =>
      Effect.gen(function* () {
        yield* notify(failure, "agent-failure");
        return yield* Effect.fail(
          new PortFailure(new Error(`agent failed: ${failure.details} (retryable=${failure.retryable})`)),
        );
      });
    yield* Stream.runForEachWhile(events, (event) => {
      if (event.type === "accepted") messageId = event.message.messageId;
      if (event.type === "serving_error") servingError = event.message;
      const end = turnEnd(event, messageId);
      if (end === undefined) {
        return Effect.try({
          try: () => {
            opts.onEvent(event);
            return true;
          },
          catch: (cause) => new PortFailure(cause),
        });
      }
      return Effect.gen(function* () {
        yield* opts.finish;
        finalized = true;
        if ("answered" in end) {
          const answer = opts.answer();
          yield* Effect.try({
            try: () => opts.onAnswered?.(answer),
            catch: (cause) => new PortFailure(cause),
          });
          yield* opts.settle(answer);
        } else {
          return yield* failWith(end.failure);
        }
        return false;
      }).pipe(Effect.uninterruptible);
    });
    if (finalized) return;
    const unfinished = unfinishedTurn(servingError);
    if (unfinished === undefined) {
      return yield* Effect.fail(new PortFailure(new Error("stream ended without a terminal event")));
    }
    yield* opts.finish;
    finalized = true;
    yield* failWith(unfinished).pipe(Effect.uninterruptible);
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
        yield* portJoin(opts.flush).pipe(
          Effect.catchTag("PortFailure", (error) =>
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
  finish: Effect.Effect<void, PortFailure>;
}

export function serialWriter(): Effect.Effect<SerialWriter, never, Scope.Scope> {
  return Effect.gen(function* () {
    const queue = yield* Queue.unbounded<() => Promise<void>, Cause.Done>();
    const work = Effect.gen(function* () {
      for (;;) {
        const next = yield* Queue.take(queue);
        yield* portJoin(next).pipe(Effect.uninterruptible);
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
