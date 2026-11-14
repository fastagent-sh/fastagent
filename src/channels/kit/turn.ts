/**
 * Durable channel turn runner, steered-turn gate, side-task tracker, `/stop` dispatch, and shared discussion reader.
 */
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { type Agent, AgentError, type Message } from "../../agent-api.ts";
import { type PromiseFailure, originalError, joinPromise } from "../../promise-bridge.ts";
import { log } from "../../log.ts";
import { beginWork } from "../busy.ts";
import { type TurnSlot, createTurnQueue, unqueuedSlot } from "../turn-queue.ts";
import { foldBudget } from "./fold-budget.ts";
import { type AskLog, type Discussion, type PlaceHistory, type PlaceMessage, readStart } from "./history.ts";
import type { TurnEvent } from "./invoke.ts";
import type { SeenRing } from "./state.ts";
import type { TurnRecordBase, TurnStore } from "./turn-store.ts";

export const SHARED_ANSWER_NOTICE = "↑ Answered together with an earlier message above.";
export const DROPPED_TURN_NOTICE = "⚠️ I couldn’t complete an earlier request — please ask again.";

export function isStopText(text: string): boolean {
  return /^(stop|cancel)[.!]?$/i.test(text.trim());
}

const STOPPED_NOTICE = "⏹ Stopped.";
const NOTHING_RUNNING_NOTICE = "Nothing is running.";
const UNKNOWN_NOTICE = "⚠️ Could not tell whether it stopped — check again in a moment.";

export async function dispatchStop(
  agent: Pick<Agent, "sessions">,
  sessionId: string | undefined,
  label: string,
): Promise<string> {
  if (sessionId === undefined) return NOTHING_RUNNING_NOTICE;
  try {
    const { stopped } = await agent.sessions.cancel(sessionId);
    return stopped.length > 0 ? STOPPED_NOTICE : NOTHING_RUNNING_NOTICE;
  } catch (error) {
    if (error instanceof AgentError && error.code === "not_found") return NOTHING_RUNNING_NOTICE;
    const code = error instanceof AgentError ? error.code : undefined;
    log.warn(
      `${label} stop failed for ${sessionId}: ${code ?? "error"} — ${error instanceof Error ? error.message : String(error)}`,
    );
    if (code === undefined || code === "unavailable") return UNKNOWN_NOTICE;
    return `⚠️ Could not stop (${code}).`;
  }
}

function createTaskTracker(label: string): { track(task: Promise<unknown>): void; drain(): Promise<void> } {
  const tasks = new Set<Fiber.Fiber<void>>();
  return {
    track(task) {
      const workDone = beginWork();
      const fiber = Effect.runFork(
        joinPromise(() => task).pipe(
          Effect.asVoid,
          Effect.catchCause((cause) =>
            Effect.sync(() => log.warn(`${label} side task rejected: ${String(originalError(cause))}`)),
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

/** Shared discussion fold over `AskLog` + `PlaceHistory` for channels whose platform supports history reads. */
export async function readPlaceDiscussion<C>(opts: {
  agent: Agent;
  label: string;
  asks: AskLog<C>;
  history: PlaceHistory<C>;
  sessionId: string | undefined;
  historyKey: string | undefined;
  conversation: string;
  turnId: string;
  until: C | undefined;
}): Promise<Discussion<PlaceMessage>> {
  if (opts.historyKey === undefined || opts.until === undefined) return { text: "", folded: [] };
  const start = await readStart(opts.asks, opts.label, opts.conversation, opts.sessionId, opts.until);
  const fold = await opts.history.fold({
    key: opts.historyKey,
    conversation: opts.conversation,
    budget: await foldBudget(opts.agent, opts.sessionId),
    ...(start.after === undefined ? {} : { after: start.after }),
    until: opts.until,
  });
  if (fold.unread) opts.asks.forget(opts.conversation, opts.turnId);
  return start.unreadable === undefined ? fold : { ...fold, text: `${start.unreadable}\n${fold.text}`.trimEnd() };
}

function gatedReply(opts: {
  events: Stream.Stream<TurnEvent, PromiseFailure>;
  held: boolean;
  awaitEarlier: Effect.Effect<void>;
  answerKey: () => string | undefined;
  delivered: (answerKey: string) => boolean;
  render: (events: Stream.Stream<TurnEvent, PromiseFailure>) => Effect.Effect<void, PromiseFailure, Scope.Scope>;
  skipped: (answerKey: string) => Effect.Effect<void>;
}): Effect.Effect<void, PromiseFailure, Scope.Scope> {
  if (!opts.held) return opts.render(opts.events);
  return Effect.gen(function* () {
    const queue = yield* Queue.unbounded<TurnEvent, PromiseFailure | Cause.Done>();
    const over = Deferred.makeUnsafe<void>();
    yield* Effect.forkScoped(
      Stream.runForEach(opts.events, (event) => Effect.sync(() => void Queue.offerUnsafe(queue, event))).pipe(
        Effect.matchCauseEffect({
          onSuccess: () => Queue.end(queue),
          onFailure: (cause) => Queue.failCause(queue, cause as Cause.Cause<PromiseFailure>),
        }),
        Effect.ensuring(Effect.sync(() => void Deferred.doneUnsafe(over, Effect.void))),
      ),
    );
    yield* Deferred.await(over);
    yield* opts.awaitEarlier;
    const key = opts.answerKey();
    if (key !== undefined && opts.delivered(key)) {
      yield* opts.skipped(key);
      return;
    }
    yield* opts.render(Stream.fromQueue(queue));
  });
}

export type PendingBase<S extends TurnRecordBase> = Omit<S, "attempts">;

export interface TurnAck {
  complete(): Promise<void>;
  remove(): Promise<void>;
}

export const NO_ACK: TurnAck = { complete: async () => undefined, remove: async () => undefined };

function answerKeyOf(message: Message | undefined): string | undefined {
  return message?.answer === undefined ? undefined : `${message.sessionId}:${message.answer.entryId}`;
}

interface TurnHooks {
  admitted(): void;
  observe(message: Message): void;
  reply(
    events: Stream.Stream<TurnEvent, PromiseFailure>,
    render: (events: Stream.Stream<TurnEvent, PromiseFailure>) => Effect.Effect<void, PromiseFailure, Scope.Scope>,
  ): Effect.Effect<void, PromiseFailure, Scope.Scope>;
  deliverOnce(
    deliver: Effect.Effect<void, PromiseFailure, Scope.Scope>,
  ): Effect.Effect<void, PromiseFailure, Scope.Scope>;
}

export interface TurnRunnerOptions<R extends PendingBase<S>, S extends TurnRecordBase, F> {
  label: string;
  store: TurnStore<S>;
  discussion(rec: R): Promise<Discussion<F>>;
  seen?: { add(id: string): void };
  delivered: SeenRing;
  where(rec: R): string;
  beforeRun?(rec: R): Promise<boolean>;
  notifyDropped(rec: R): void;
  notifyShared?(rec: R): Promise<void>;
  acknowledgeHeld?(rec: R): Promise<TurnAck>;
  execute(
    rec: R,
    discussion: Discussion<F>,
    onAnswered: (answer: string) => void,
    turn: TurnHooks,
  ): Effect.Effect<void, PromiseFailure, Scope.Scope>;
  deliverAnswer(rec: R, answer: string): Effect.Effect<void, PromiseFailure, Scope.Scope>;
}

export interface TurnRunner<R, S> {
  submit(rec: R, persist: boolean): void;
  recover(): S[];
  /** Track off-queue channel work (e.g. `/stop` feedback) so `idle()` drains it alongside queued turns. */
  track(task: Promise<unknown>): void;
  idle(): Promise<void>;
}

function runQueuedTurn<R extends PendingBase<S>, S extends TurnRecordBase, F>(
  options: TurnRunnerOptions<R, S, F>,
  rec: R,
  slot: TurnSlot = unqueuedSlot,
  afterRestart = false,
): Effect.Effect<void, PromiseFailure> {
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
        yield* joinPromise(() => notify(rec)).pipe(
          Effect.catchTag("PromiseFailure", (error) =>
            Effect.sync(() =>
              log.warn(`${label} turn ${rec.id}: could not say where its shared answer is: ${String(error.cause)}`),
            ),
          ),
        );
      });
    const acknowledged = (
      ack: () => Promise<TurnAck>,
      reply: Effect.Effect<void, PromiseFailure, Scope.Scope>,
    ): Effect.Effect<void, PromiseFailure, Scope.Scope> =>
      Effect.gen(function* () {
        const started = yield* Effect.forkScoped(
          joinPromise(ack).pipe(
            Effect.catchTag("PromiseFailure", (error) =>
              Effect.sync(() => {
                log.warn(`${label} turn ${rec.id}: could not acknowledge its message: ${String(error.cause)}`);
                return NO_ACK;
              }),
            ),
          ),
        );
        yield* Effect.addFinalizer((exit) =>
          Fiber.join(started).pipe(
            Effect.flatMap((mark) => joinPromise(() => (exit._tag === "Success" ? mark.complete() : mark.remove()))),
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
    if (beforeRun && !(yield* joinPromise(() => beforeRun(rec)))) return;
    const decision = store.startAttempt(rec.id);
    if (decision === "exceeded") {
      const stranded = rec.answer;
      if (stranded === undefined) {
        options.notifyDropped(rec);
        return;
      }
      return yield* Effect.scoped(hooks.deliverOnce(options.deliverAnswer(rec, stranded))).pipe(
        Effect.matchEffect({
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
              options.notifyDropped(rec);
            }),
        }),
      );
    }
    if (decision === "defer") return;
    const startedAt = Date.now();
    const recovered = rec.answer;
    let answered = recovered !== undefined;
    if (recovered !== undefined) slot.release();
    log.info(
      `${label} turn start: turn=${rec.id} conversation=${rec.conversation} ${options.where(rec)}` +
        `${recovered === undefined ? "" : " mode=re-delivery (answer recovered from a prior run)"}`,
    );
    const work =
      recovered !== undefined
        ? Effect.suspend(() => hooks.deliverOnce(options.deliverAnswer(rec, recovered)))
        : joinPromise(() => options.discussion(rec)).pipe(
            Effect.flatMap((discussion) =>
              options.execute(
                rec,
                discussion,
                (answer) => {
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
    if (delivered || !answered) {
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
  const sideTasks = createTaskTracker(label);
  const queue = createTurnQueue<R>({
    label,
    run: (rec, slot) => runQueuedTurn(options, rec, slot, recoveredIds.delete(rec.id)),
  });
  const recoveredIds = new Set<string>();
  const submit = (rec: R, persist: boolean): void => {
    if (persist) {
      store.add({ ...rec, attempts: 0 } as unknown as S);
      seen?.add(rec.id);
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
        const { attempts: _attempts, ...intent } = stored;
        submit(intent as unknown as R, false);
      }
      return recovered;
    },
    track: (task) => sideTasks.track(task),
    idle: () => Promise.all([queue.idle(), sideTasks.drain()]).then(() => undefined),
  };
}
