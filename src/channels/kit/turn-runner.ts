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
    onCompleted: () => void,
  ): Effect.Effect<void, PortFailure, Scope.Scope>;
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
      options.notifyDropped(rec);
      return;
    }
    if (decision === "defer") {
      options.onDeferred(rec);
      return;
    }
    const startedAt = Date.now();
    log.info(`${label} turn start: turn=${rec.id} session=${rec.session} ${options.where(rec)}`);
    const bufferKey = options.bufferKey(rec);
    const discussion = buffer.peek(bufferKey);
    yield* Effect.scoped(
      Effect.suspend(() =>
        options.execute(rec, discussion, () =>
          commitAnsweredTurn(store, buffer, { id: rec.id, bufferKey, consumed: discussion.consumed }),
        ),
      ),
    ).pipe(
      Effect.matchEffect({
        onSuccess: () =>
          Effect.sync(() =>
            log.info(`${label} turn done: turn=${rec.id} session=${rec.session} (${Date.now() - startedAt}ms)`),
          ),
        onFailure: (error) =>
          Effect.sync(() =>
            log.error(
              `${label} turn failed: turn=${rec.id} session=${rec.session} (${Date.now() - startedAt}ms): ${String(error.cause)}`,
            ),
          ),
      }),
    );
    // Caught execution/delivery failures are not replay-safe. Interruption never reaches this removal.
    store.remove(rec.id);
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
