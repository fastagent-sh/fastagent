/** The durable-turn LIFECYCLE the stateful chat channels share, over the kit's parts. */
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";
import { log } from "../../log.ts";
import { type PortFailure, portError, portJoin } from "../../effect-port.ts";
import type { ContextBuffer } from "./context-buffer.ts";
import { createTurnQueue } from "./turn-queue.ts";
import { type TurnRecordBase, type TurnStore, commitAnsweredTurn } from "./turn-store.ts";

/**
 * A pending turn is the persisted intent minus its attempt count, plus live-only fields the channel adds (a notice's
 * message id).
 */
export type PendingBase<S extends TurnRecordBase> = Omit<S, "attempts">;

export interface TurnRunnerOptions<R extends PendingBase<S>, S extends TurnRecordBase, E> {
  label: string;
  store: TurnStore<S>;
  buffer: ContextBuffer<E>;
  /** Delivery dedup by platform id, recorded post-persist (Slack, Feishu). */
  seen?: { add(id: string): void };
  /** The persisted intent for a pending turn — drops the live-only fields. */
  toStored(rec: R): S;
  /** A recovered intent as a pending turn — live-only fields start absent. */
  fromStored(stored: S): R;
  /** The context-buffer bucket this turn folds. */
  bufferKey(rec: R): string;
  /** The place, for the lifecycle log line (`chat=… thread=…`). */
  where(rec: R): string;
  /** Queue feedback when a turn is scheduled BEHIND an active one. */
  onQueuedBehind?(rec: R): { done: Promise<void>; cancel?: () => void };
  /** Runs before the attempt is counted. */
  beforeRun?(rec: R): Promise<boolean>;
  /**
   * The attempt could not be recorded (disk failure): a restart replays the turn, so say so on any notice it holds
   * rather than leaving it pinned at "Queued".
   */
  onDeferred(rec: R): void;
  /** The turn started the ceiling's worth of times without finishing: tell the asker. */
  notifyDropped(rec: R): void;
  execute(
    rec: R,
    discussion: { text: string; consumed: E[] },
    /** Called with the finished reply just before it is delivered — the point the answer becomes recoverable. */
    onAnswered: (answer: string) => void,
  ): Effect.Effect<void, PortFailure, Scope.Scope>;
  /**
   * Deliver an answer a previous run generated but never confirmed delivering: no model, no tools, and no live
   * preview — the one the answer was written for died with its process.
   *
   * A notice THIS process put up is a different thing and must still be settled: a record recovered behind another
   * turn in the same session goes through `onQueuedBehind` like any other, so it can hold a fresh "queued" message
   * or status that only this call can take over or clear.
   */
  deliverAnswer(rec: R, answer: string): Effect.Effect<void, PortFailure, Scope.Scope>;
}

export interface TurnRunner<R, S> {
  /**
   * Accept a turn: persist its intent (pre-ACK — a failed write throws so the platform redelivers), record the
   * delivery id, enqueue.
   */
  submit(rec: R, persist: boolean): void;
  /** Re-enqueue the turns a prior crash left mid-flight; returns them so a channel can continue its arrival counter. */
  recover(): S[];
  /** Resolve once no turn is in flight — the test/observability seam. */
  idle(): Promise<void>;
}

export function runQueuedTurn<R extends PendingBase<S>, S extends TurnRecordBase, E>(
  options: TurnRunnerOptions<R, S, E>,
  rec: R,
): Effect.Effect<void, PortFailure> {
  return Effect.gen(function* () {
    const { label, store, buffer, beforeRun } = options;
    if (beforeRun && !(yield* portJoin(() => beforeRun(rec)))) return;
    const decision = store.startAttempt(rec.id);
    if (decision === "exceeded") {
      const stranded = rec.answer;
      if (stranded === undefined) {
        options.notifyDropped(rec);
        return;
      }
      // The ceiling is about EXECUTION — a turn that may be crashing the process must stop being run. Delivering a
      // recorded answer costs one message and no model call, so the record the store just dropped gets one last
      // send instead of "please ask again" over an answer that exists.
      return yield* Effect.scoped(options.deliverAnswer(rec, stranded)).pipe(
        Effect.matchEffect({
          // The store has already said, at error level, that this turn will not be run again. Silence after that
          // reads as "nothing happened"; this line is what distinguishes it from a delivered answer.
          onSuccess: () =>
            Effect.sync(() =>
              log.info(
                `${label} turn ${rec.id} hit the execution ceiling, but the answer it had already recorded was ` +
                  `delivered (session=${rec.session})`,
              ),
            ),
          onFailure: (error) =>
            Effect.sync(() => {
              log.error(
                `${label} turn ${rec.id} hit the execution ceiling and its recorded answer could not be delivered ` +
                  `either (session=${rec.session}) — the answer is gone: ${String(error.cause)}`,
              );
              // The record is off disk, so nothing will retry this. The asker is owed an ending — without one, a
              // queue notice this turn put up stays in the chat forever reading "Queued".
              options.notifyDropped(rec);
            }),
        }),
      );
    }
    if (decision === "defer") {
      options.onDeferred(rec);
      return;
    }
    const startedAt = Date.now();
    // A recovered answer skips the buffer entirely: its discussion was committed when the answer was recorded, and
    // peeking again would consume entries this turn never folded in.
    const recovered = rec.answer;
    let answered = recovered !== undefined;
    // One stable prefix, so every `turn done:`/`turn failed:` has a `turn start:` to grep back to; what kind of work
    // it is rides along as a field.
    log.info(
      `${label} turn start: turn=${rec.id} session=${rec.session} ${options.where(rec)}` +
        `${recovered === undefined ? "" : " mode=re-delivery (answer recovered from a prior run)"}`,
    );
    const work =
      recovered !== undefined
        ? Effect.suspend(() => options.deliverAnswer(rec, recovered))
        : Effect.suspend(() => {
            const bufferKey = options.bufferKey(rec);
            const discussion = buffer.peek(bufferKey);
            return options.execute(rec, discussion, (answer) => {
              // Only a recorded answer is recoverable — an untracked run has no record to keep it in.
              answered = commitAnsweredTurn(store, buffer, {
                id: rec.id,
                bufferKey,
                consumed: discussion.consumed,
                answer,
              });
            });
          });
    const delivered = yield* Effect.scoped(work).pipe(
      Effect.matchEffect({
        onSuccess: () =>
          Effect.sync(() => {
            log.info(`${label} turn done: turn=${rec.id} session=${rec.session} (${Date.now() - startedAt}ms)`);
            return true;
          }),
        onFailure: (error) =>
          Effect.sync(() => {
            log.error(
              `${label} turn failed: turn=${rec.id} session=${rec.session} (${Date.now() - startedAt}ms): ${String(error.cause)}`,
            );
            return false;
          }),
      }),
    );
    // An answer that exists but did not reach the chat is the one failure worth another start: re-delivering it costs
    // one message and no model call, and `startAttempt` bounds how often that is tried. Everything else — delivered,
    // or failed before there was an answer — is done here. Interruption never reaches this removal.
    if (delivered || !answered) {
      store.remove(rec.id);
      return;
    }
    log.warn(
      `${label} turn ${rec.id} produced an answer that was not delivered (session=${rec.session}) — ` +
        `keeping it to re-deliver on the next start`,
    );
  });
}

export function createTurnRunner<
  R extends PendingBase<S> & { id: string; session: string },
  S extends TurnRecordBase,
  E,
>(options: TurnRunnerOptions<R, S, E>): TurnRunner<R, S> {
  const { label, store, seen, onQueuedBehind } = options;
  const notices = new Map<string, { done: Fiber.Fiber<void>; cancel?: () => void }>();
  const queue = createTurnQueue<R>({
    label,
    onQueuedBehind:
      onQueuedBehind &&
      ((rec) => {
        const notice = onQueuedBehind(rec);
        // Observe rejection at acceptance, even if dequeue is minutes away.
        const done = Effect.runFork(
          portJoin(() => notice.done).pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() =>
                log.warn(
                  `${label} queue notice failed: turn=${rec.id} session=${rec.session}: ${String(portError(cause))}`,
                ),
              ),
            ),
          ),
        );
        notices.set(rec.id, { done, cancel: notice.cancel });
      }),
    run: (rec) =>
      Effect.gen(function* () {
        const notice = notices.get(rec.id);
        notices.delete(rec.id);
        if (notice) {
          // A broken cancel hook must still join any post already in flight.
          yield* Effect.addFinalizer(() => Fiber.await(notice.done));
          notice.cancel?.();
          yield* Fiber.await(notice.done);
        }
        yield* runQueuedTurn(options, rec);
      }),
  });
  const submit = (rec: R, persist: boolean): void => {
    if (persist) {
      store.add(options.toStored(rec)); // pre-ACK: a failed write throws → 500 → redelivery
      seen?.add(rec.id); // post-persist — recording first could turn a failed write into silent loss
    }
    queue.accept(rec);
  };
  return {
    submit,
    recover() {
      const recovered = store.recover();
      if (recovered.length > 0) log.info(`${label} recovering ${recovered.length} unfinished turn(s) from a prior run`);
      for (const stored of recovered) submit(options.fromStored(stored), false);
      return recovered;
    },
    idle: () => queue.idle(),
  };
}
