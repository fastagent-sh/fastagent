/** The durable-turn LIFECYCLE the stateful chat channels share, over the kit's parts. */
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";
import type { Message } from "../../agent-api.ts";
import { log } from "../../log.ts";
import { type PortFailure, portJoin } from "../../effect-port.ts";
import type { TurnEvent } from "./invoke-turn-kit.ts";
import type { Discussion } from "./place-history.ts";
import type { SeenRing } from "./seen.ts";
import { gatedReply } from "./turn-gate.ts";
import { type TurnSlot, createTurnQueue, unqueuedSlot } from "../turn-queue.ts";
import type { TurnRecordBase, TurnStore } from "./turn-store.ts";

/**
 * A pending turn is the persisted intent minus its attempt count, plus live-only fields the channel adds (a notice's
 * message id).
 */
export type PendingBase<S extends TurnRecordBase> = Omit<S, "attempts">;

/** A light acknowledgement on the asker's message (a reaction) while its turn waits, settled when the turn ends. */
export interface TurnAck {
  /** The turn ended with an answer (its own, or the earlier input's it shared). */
  complete(): Promise<void>;
  /** The turn ended without one. */
  remove(): Promise<void>;
}

/** An acknowledgement that does nothing: where none could be made. */
export const NO_ACK: TurnAck = { complete: async () => undefined, remove: async () => undefined };

/** `<session>:<entry>`: the Agent's answer a message ended with, the unit a delivery is recorded by. */
function answerKeyOf(message: Message | undefined): string | undefined {
  return message?.answer === undefined ? undefined : `${message.sessionId}:${message.answer.entryId}`;
}

/** What the runner gives a turn beyond its inputs: how its message is sent, and how its reply and answer are delivered. */
interface TurnHooks {
  /** The turn's message is recorded with the Agent (or was refused): the next input may be prepared and sent. */
  admitted(): void;
  /** The turn's own message ended, as the Agent reports it. */
  observe(message: Message): void;
  /**
   * Render the turn's reply from its message's events. An input steered into a run that was still going shares that
   * run's answer, which the earlier turn delivers: such a turn renders nothing when that is done.
   */
  reply(
    events: Stream.Stream<TurnEvent, PortFailure>,
    render: (events: Stream.Stream<TurnEvent, PortFailure>) => Effect.Effect<void, PortFailure, Scope.Scope>,
  ): Effect.Effect<void, PortFailure, Scope.Scope>;
  /** Run `deliver` for a recovered answer, unless an earlier turn delivered it already. */
  deliverOnce(deliver: Effect.Effect<void, PortFailure, Scope.Scope>): Effect.Effect<void, PortFailure, Scope.Scope>;
}

export interface TurnRunnerOptions<R extends PendingBase<S>, S extends TurnRecordBase, F> {
  label: string;
  store: TurnStore<S>;
  /**
   * What a turn folds beyond its own ask: the place's discussion from where its session last read to, up to the turn's
   * own ask. It reads nothing for a turn with no place (a routed one). Never rejects: a source that cannot read says
   * so in its text, and the turn goes on without it.
   */
  discussion(rec: R): Promise<Discussion<F>>;
  /** Delivery dedup by platform id, recorded post-persist (Slack, Feishu). */
  seen?: { add(id: string): void };
  /**
   * The answers already delivered (`<session>:<entry>`): inputs steered into one run share its answer, and an input is
   * skipped when its answer is in here.
   */
  delivered: SeenRing;
  /** The persisted intent for a pending turn — drops the live-only fields. */
  toStored(rec: R): S;
  /** A recovered intent as a pending turn — live-only fields start absent. */
  fromStored(stored: S): R;
  /** The place, for the lifecycle log line (`chat=… thread=…`). */
  where(rec: R): string;
  /** Runs before the attempt is counted. */
  beforeRun?(rec: R): Promise<boolean>;
  /** The turn started the ceiling's worth of times without finishing: tell the asker. */
  notifyDropped(rec: R): void;
  /**
   * The turn's input was answered together with an earlier one, so it sends nothing of its own: tell the asker where the
   * answer is, when it is not under their message (a group's answer quotes the first asker). Absent: say nothing.
   */
  notifyShared?(rec: R): Promise<void>;
  /**
   * The turn's input was steered into a run that is still going (or the turn restarted), so nothing of its own shows
   * until that run ends: mark the asker's message. Best effort: an acknowledgement is decoration and must not fail the
   * turn, so a rejection is logged and the turn goes on without one.
   */
  acknowledgeHeld?(rec: R): Promise<TurnAck>;
  execute(
    rec: R,
    discussion: Discussion<F>,
    /** Called with the finished reply just before it is delivered — the point the answer becomes recoverable. */
    onAnswered: (answer: string) => void,
    turn: TurnHooks,
  ): Effect.Effect<void, PortFailure, Scope.Scope>;
  /**
   * Deliver an answer a previous run generated but never confirmed delivering: no model, no tools, and no live
   * preview — the one the answer was written for died with its process.
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

export function runQueuedTurn<R extends PendingBase<S>, S extends TurnRecordBase, F>(
  options: TurnRunnerOptions<R, S, F>,
  rec: R,
  slot: TurnSlot = unqueuedSlot,
  /** The turn was left by an earlier process, so its message may have been sent and answered already. */
  afterRestart = false,
): Effect.Effect<void, PortFailure> {
  return Effect.gen(function* () {
    const { label, store, beforeRun } = options;
    let ended: Message | undefined;
    const answerKey = (): string | undefined => answerKeyOf(ended) ?? rec.answerKey;
    const wasDelivered = (key: string): boolean => options.delivered.has(key);
    const sharedAnswer = (key: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        log.info(`${label} turn ${rec.id}: its answer was delivered with an earlier input's (${key})`);
        if (options.notifyShared === undefined) return;
        const notify = options.notifyShared;
        yield* portJoin(() => notify(rec)).pipe(
          Effect.catchTag("PortFailure", (error) =>
            Effect.sync(() =>
              log.warn(`${label} turn ${rec.id}: could not say where its shared answer is: ${String(error.cause)}`),
            ),
          ),
        );
      });
    /**
     * Mark the asker's message while `reply` runs, then settle the mark by how it ended. Started beside the reply so the
     * mark's round trip does not hold back sending the message; settled in a finalizer, which logs and never fails.
     */
    const acknowledged = (
      ack: () => Promise<TurnAck>,
      reply: Effect.Effect<void, PortFailure, Scope.Scope>,
    ): Effect.Effect<void, PortFailure, Scope.Scope> =>
      Effect.gen(function* () {
        const started = yield* Effect.forkScoped(
          portJoin(ack).pipe(
            Effect.catchTag("PortFailure", (error) =>
              Effect.sync(() => {
                log.warn(`${label} turn ${rec.id}: could not acknowledge its message: ${String(error.cause)}`);
                return NO_ACK;
              }),
            ),
          ),
        );
        yield* Effect.addFinalizer((exit) =>
          Fiber.join(started).pipe(
            Effect.flatMap((mark) => portJoin(() => (exit._tag === "Success" ? mark.complete() : mark.remove()))),
            Effect.catchCause((cause) =>
              Effect.sync(() =>
                log.warn(`${label} turn ${rec.id}: could not settle its acknowledgement: ${String(cause)}`),
              ),
            ),
          ),
        );
        yield* reply;
      });
    const hooks: TurnHooks = {
      admitted: slot.release,
      observe: (message) => {
        ended = message;
      },
      reply: (events, render) => {
        const held = afterRestart || slot.earlierRunning();
        const reply = gatedReply({
          events,
          held,
          awaitEarlier: slot.awaitEarlier,
          answerKey,
          delivered: wasDelivered,
          render,
          skipped: sharedAnswer,
        });
        const acknowledge = options.acknowledgeHeld;
        return held && acknowledge !== undefined ? acknowledged(() => acknowledge(rec), reply) : reply;
      },
      deliverOnce: (deliver) =>
        Effect.gen(function* () {
          yield* slot.awaitEarlier;
          const key = answerKey();
          if (key !== undefined && wasDelivered(key)) {
            yield* sharedAnswer(key);
            return;
          }
          yield* deliver;
        }),
    };
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
      return yield* Effect.scoped(hooks.deliverOnce(options.deliverAnswer(rec, stranded))).pipe(
        Effect.matchEffect({
          // The store has already said, at error level, that this turn will not be run again. Silence after that
          // reads as "nothing happened"; this line is what distinguishes it from a delivered answer.
          onSuccess: () =>
            Effect.sync(() =>
              log.info(
                `${label} turn ${rec.id} hit the execution ceiling, but the answer it had already recorded was ` +
                  `delivered (conversation=${rec.conversation})`,
              ),
            ),
          onFailure: (error) =>
            Effect.sync(() => {
              log.error(
                `${label} turn ${rec.id} hit the execution ceiling and its recorded answer could not be delivered ` +
                  `either (conversation=${rec.conversation}) — the answer is gone: ${String(error.cause)}`,
              );
              // The record is off disk, so nothing will retry this. The asker is owed an ending — without one, a
              // queue notice this turn put up stays in the chat forever reading "Queued".
              options.notifyDropped(rec);
            }),
        }),
      );
    }
    // The store has logged that the attempt could not be recorded; a restart replays the turn.
    if (decision === "defer") return;
    const startedAt = Date.now();
    // A recovered answer reads no discussion: the answer exists, and only its delivery is owed.
    const recovered = rec.answer;
    let answered = recovered !== undefined;
    // A recovered answer is not sent to the Agent: there is nothing to prepare, and nothing for the next input to wait for.
    if (recovered !== undefined) slot.release();
    // One stable prefix, so every `turn done:`/`turn failed:` has a `turn start:` to grep back to; what kind of work
    // it is rides along as a field.
    log.info(
      `${label} turn start: turn=${rec.id} conversation=${rec.conversation} ${options.where(rec)}` +
        `${recovered === undefined ? "" : " mode=re-delivery (answer recovered from a prior run)"}`,
    );
    const work =
      recovered !== undefined
        ? Effect.suspend(() => hooks.deliverOnce(options.deliverAnswer(rec, recovered)))
        : portJoin(() => options.discussion(rec)).pipe(
            Effect.flatMap((discussion) =>
              options.execute(
                rec,
                discussion,
                (answer) => {
                  // Only a recorded answer is recoverable — an untracked run has no record to keep it in.
                  answered = store.answered(rec.id, answer, answerKey());
                },
                hooks,
              ),
            ),
          );
    const delivered = yield* Effect.scoped(work).pipe(
      Effect.matchEffect({
        onSuccess: () =>
          Effect.sync(() => {
            log.info(
              `${label} turn done: turn=${rec.id} conversation=${rec.conversation} (${Date.now() - startedAt}ms)`,
            );
            return true;
          }),
        onFailure: (error) =>
          Effect.sync(() => {
            log.error(
              `${label} turn failed: turn=${rec.id} conversation=${rec.conversation} (${Date.now() - startedAt}ms): ${String(error.cause)}`,
            );
            return false;
          }),
      }),
    );
    // An answer that exists but did not reach the chat is the one failure worth another start: re-delivering it costs
    // one message and no model call, and `startAttempt` bounds how often that is tried. Everything else — delivered,
    // or failed before there was an answer — is done here. Interruption never reaches this removal.
    if (delivered || !answered) {
      // Before the record goes: a crash between the two leaves a record whose answer is skipped, not delivered twice.
      const key = answerKey();
      if (delivered && key !== undefined) options.delivered.add(key);
      store.remove(rec.id);
      return;
    }
    log.warn(
      `${label} turn ${rec.id} produced an answer that was not delivered (conversation=${rec.conversation}) — ` +
        `keeping it to re-deliver on the next start`,
    );
  });
}

export function createTurnRunner<
  R extends PendingBase<S> & { id: string; conversation: string },
  S extends TurnRecordBase,
  F,
>(options: TurnRunnerOptions<R, S, F>): TurnRunner<R, S> {
  const { label, store, seen } = options;
  const queue = createTurnQueue<R>({
    label,
    run: (rec, slot) => runQueuedTurn(options, rec, slot, recoveredIds.delete(rec.id)),
  });
  const recoveredIds = new Set<string>();
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
      for (const stored of recovered) {
        recoveredIds.add(stored.id);
        submit(options.fromStored(stored), false);
      }
      return recovered;
    },
    idle: () => queue.idle(),
  };
}
