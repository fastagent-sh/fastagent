/**
 * Whether a steered turn renders its own reply live, or waits for the end of its message first (docs/design/place-sessions.md).
 *
 * Inputs steered into a running session can end with one shared answer, which the earlier turn delivers. A turn that
 * began while an earlier one was still running, or that runs again after a restart, may hold that very answer: it is
 * held back until its own message ends, and skipped when the answer was delivered. Any other turn is a live reply.
 */
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { Message } from "../../agent-api.ts";
import type { PortFailure } from "../../effect-port.ts";
import type { TurnEvent } from "./invoke-turn-kit.ts";

/** `<session>:<entry>`: the Agent's answer a message ended with, the unit a delivery is recorded by. */
export function answerKeyOf(message: Message | undefined): string | undefined {
  return message?.answer === undefined ? undefined : `${message.sessionId}:${message.answer.entryId}`;
}

export function gatedReply(opts: {
  events: Stream.Stream<TurnEvent, PortFailure>;
  /** The answer may be shared with an earlier turn's: an earlier turn is running, or this one is run again. */
  held: boolean;
  /** Resolves once the earlier turns have ended, and delivered what they answered. */
  awaitEarlier: Effect.Effect<void>;
  /** Whether this answer was delivered already. */
  delivered: (answerKey: string) => boolean;
  /** Runs for a turn that is not skipped. */
  render: (events: Stream.Stream<TurnEvent, PortFailure>) => Effect.Effect<void, PortFailure, Scope.Scope>;
  /** For the log, when a turn is skipped. */
  skipped: (answerKey: string) => void;
}): Effect.Effect<void, PortFailure, Scope.Scope> {
  if (!opts.held) return opts.render(opts.events);
  return Effect.gen(function* () {
    const queue = yield* Queue.unbounded<TurnEvent, PortFailure | Cause.Done>();
    const over = Deferred.makeUnsafe<void>();
    let own: Message | undefined;
    let ended: Message | undefined;
    yield* Effect.forkScoped(
      Stream.runForEach(opts.events, (event) =>
        Effect.sync(() => {
          if (event.type === "message") own = event.message;
          else if (event.type === "done" && event.message.id === own?.id) {
            ended = event.message;
            void Deferred.doneUnsafe(over, Effect.void);
          }
          Queue.offerUnsafe(queue, event);
        }),
      ).pipe(
        Effect.matchCauseEffect({
          onSuccess: () => Queue.end(queue),
          onFailure: (cause) => Queue.failCause(queue, cause as Cause.Cause<PortFailure>),
        }),
        Effect.ensuring(Effect.sync(() => void Deferred.doneUnsafe(over, Effect.void))),
      ),
    );
    yield* Deferred.await(over);
    yield* opts.awaitEarlier;
    const key = answerKeyOf(ended);
    if (key !== undefined && opts.delivered(key)) {
      opts.skipped(key);
      return;
    }
    yield* opts.render(Stream.fromQueue(queue));
  });
}
