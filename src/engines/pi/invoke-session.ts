/** Pi's per-invoke binding over a durable session record. */
import type { AgentSession, AgentSessionEvent, AgentToolResult } from "@earendil-works/pi-coding-agent";
import { type AssistantMessage, contentText } from "@earendil-works/pi-ai";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import type * as EffectScope from "effect/Scope";
import {
  ABORTED_CODE,
  SESSION_BUSY_CODE,
  type Agent,
  type AgentEvent,
  type Json,
  type Prompt,
  type Scope,
} from "../../agent.ts";
import type { PromptDisposition, RunSettledEvent, SessionEvent, UserMessageEvent } from "../../session.ts";
import { entryImages } from "./entry-images.ts";
import { type CancelHooks, cancellableStream } from "../../collect.ts";
import { log } from "../../log.ts";
import { toRetryScheduledEvent } from "./retry-event.ts";
import type { SessionInheritance } from "./session-inheritance.ts";
import { PortFailure, port, portAbort, portCleanup, portError } from "../../effect-port.ts";
import { SessionBusy, acquireSession, acquireSessionLease } from "./session-effects.ts";
import {
  type Lease,
  type RunControls,
  type SessionObserver,
  errorToTerminal,
  inProcessLease,
  agentEventProjection,
  toPiPromptOptions,
  toTerminal,
} from "./turn-kit.ts";

/** Open or create a record and bind a session. */
export type PiAgentSessionFactory = (sessionId: string, inherit?: SessionInheritance) => Promise<AgentSession>;

export interface CreatePiAgentFromSessionOptions {
  sessionFactory: PiAgentSessionFactory;
  /** Shared with control-plane writes; admission is synchronous and fail-fast. */
  lease?: Lease;
  /** Trusted observation tap; controls arrive with run_started, before session binding. */
  observer?: SessionObserver;
}

// Structured output is for scripts. Observation publishes Pi's display result, including bounded nested traces.
function displayToolResult(result: AgentToolResult<unknown>): Json {
  const { structuredContent: _internal, ...display } = result;
  return display as unknown as Json;
}

function toSessionEvent(event: AgentSessionEvent, runId: string): SessionEvent | null {
  const at = Date.now();
  switch (event.type) {
    case "message_start":
      if (event.message.role !== "assistant") return null;
      return { type: "message_started", timestamp: at, runId, data: {} };
    case "message_update": {
      const ev = event.assistantMessageEvent;
      if (ev.type === "text_delta" || ev.type === "thinking_delta") {
        // Empty deltas must not spend the silent window in which a provider retry is safe.
        return ev.delta === ""
          ? null
          : {
              type: "message_delta",
              timestamp: at,
              runId,
              data: { channel: ev.type === "text_delta" ? "text" : "thinking", delta: ev.delta },
            };
      }
      return null;
    }
    case "message_end":
      if (event.message.role !== "assistant") return null;
      return { type: "message_finished", timestamp: at, runId, data: {} };
    case "tool_execution_start":
      return {
        type: "tool_started",
        timestamp: at,
        runId,
        data: {
          id: event.toolCallId,
          name: event.toolName,
          args: event.args as Json,
          ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
        },
      };
    case "tool_execution_update":
      return {
        type: "tool_progress",
        timestamp: at,
        runId,
        data: {
          id: event.toolCallId,
          name: event.toolName,
          partialResult: displayToolResult(event.partialResult),
          ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
        },
      };
    case "tool_execution_end":
      return {
        type: "tool_finished",
        timestamp: at,
        runId,
        data: {
          id: event.toolCallId,
          isError: event.isError,
          content: displayToolResult(event.result),
          ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
        },
      };
    case "queue_update":
      return {
        type: "queue_changed",
        timestamp: at,
        runId,
        data: { steering: [...event.steering], followUp: [...event.followUp] },
      };
    case "auto_retry_start":
    case "summarization_retry_scheduled":
      return toRetryScheduledEvent(event, runId);
    default:
      return null;
  }
}

/** pi's error-channel events for work an invoke owes its caller: the command it ran, and the turns it started. */
const OWED_BY_THE_RUN = new Set(["command", "send_user_message", "send_message"]);

/**
 * The turns extensions start on this session and have not finished. `pi.sendUserMessage` and `pi.sendMessage` reach
 * these two session methods, and pi discards the promise; wrapping the methods keeps it. The session is this run's
 * alone, so the wrap never outlives the run.
 */
function trackExtensionTurns(session: AgentSession): ReadonlySet<Promise<void>> {
  const pending = new Set<Promise<void>>();
  const track = (sent: Promise<void>): Promise<void> => {
    pending.add(sent);
    const done = () => void pending.delete(sent);
    sent.then(done, done); // pi's own `.catch` on `sent` reports the failure
    return sent;
  };
  const sendUserMessage = session.sendUserMessage.bind(session);
  const sendCustomMessage = session.sendCustomMessage.bind(session);
  session.sendUserMessage = (...args) => track(sendUserMessage(...args));
  session.sendCustomMessage = (...args) => track(sendCustomMessage(...args));
  return pending;
}

/**
 * Report each user message when it is WRITTEN, which is later than pi announces it: pi awaits extension `message_end`
 * handlers before it appends. Emitting from the write is what makes `user_message.entryId` readable through
 * `entries()` by the time the event arrives, so a reconnecting client's backfill cannot miss a message whose event
 * fired before it subscribed. pi's agent awaits each listener before the next event, so the message still reports
 * before the answer to it. The in-memory store reuses one record across runs, so the release restores the method.
 */
function reportUserMessages(
  session: AgentSession,
  report: (data: UserMessageEvent["data"]) => void,
): Effect.Effect<void, never, EffectScope.Scope> {
  const record = session.sessionManager;
  const append = record.appendMessage;
  return Effect.acquireRelease(
    Effect.sync(() => {
      record.appendMessage = (message) => {
        const entryId = append.call(record, message);
        // The same text and images `entries()` publishes for this entry (session-control.ts toSessionEntry).
        if (message.role === "user") {
          report({ entryId, text: contentText(message.content, ""), ...entryImages(entryId, message) });
        }
        return entryId;
      };
    }),
    () =>
      Effect.sync(() => {
        record.appendMessage = append;
      }),
  );
}

export function createPiAgentFromSession(options: CreatePiAgentFromSessionOptions): Agent {
  const { sessionFactory, lease = inProcessLease(), observer } = options;

  async function* turn(
    scope: Scope,
    prompt: Prompt,
    { onCancelReady, wasCancelled }: CancelHooks,
  ): AsyncGenerator<AgentEvent> {
    const queue = Effect.runSync(Queue.unbounded<AgentEvent, Cause.Done>());
    const consumed = Deferred.makeUnsafe<void>();
    const bound = Deferred.makeUnsafe<AgentSession, SessionBusy | PortFailure>();
    const abort = new AbortController();
    onCancelReady(() => abort.abort());
    const runId = crypto.randomUUID();
    const project = agentEventProjection();
    /**
     * Each call's `tool_progress` still waiting in the queue. A newer status replaces its text instead of queuing
     * behind it, so the queue holds at most one per running call, and a consumer that falls behind (a slow `/invoke`
     * client) gets the latest status, not every snapshot in between: pi's bash reports every 100 ms, and a single
     * growing line is up to 50 KB each time. The replaced event keeps its place, which moves a status earlier, never
     * past its own call's `tool_ended`: pi takes no progress from a call once it has returned.
     */
    const unreadProgress = new Map<string, Extract<AgentEvent, { type: "tool_progress" }>>();
    let settled = false;
    let outcome: RunSettledEvent["data"] | undefined;
    let abortsInFlight = 0;
    let abortSucceeded = false;
    const observe = (event: SessionEvent | null, run?: RunControls): void => {
      if (!event || !observer) return;
      try {
        observer(scope.session, event, run);
      } catch (error) {
        log.warn(`[fastagent] session observer threw (event ${event.type}): ${String(error)}`);
      }
    };
    const ready = Deferred.await(bound);
    /**
     * Every control command obeys one admission rule: wait for this run's binding, then refuse once it has settled.
     * Kept in one place so a fourth command cannot arrive with a fifth spelling of it.
     */
    const alreadySettled = () => new PortFailure(new Error("run already settled; the command cannot take effect"));
    const command = <A>(run: (session: AgentSession) => Effect.Effect<A, PortFailure>): Promise<A> =>
      Effect.runPromise(
        Effect.gen(function* () {
          const session = yield* ready;
          if (settled) return yield* Effect.fail(alreadySettled());
          return yield* run(session);
        }),
      );
    // Prompt preparation stays OUTSIDE admission: pi accepts a message for a finished run without complaint
    // (`_steeringMessages.push`), so a run that ends between the settled check and the enqueue drops the command while
    // it reports success. Image resizing would be such a gap, hundreds of milliseconds of dynamic import and Photon
    // work, and doing it here also keeps it overlapping session acquisition. pi has a gap of its own: it awaits the
    // definition's `input` handlers before it queues, so a `queued` answer is checked against settlement once more.
    // A `handled` one stands either way: the handler took the prompt whatever became of the run.
    const enqueue = async (p: Prompt, kind: "steer" | "followUp"): Promise<PromptDisposition> => {
      const opts = await toPiPromptOptions(p, "queued");
      return command((session) =>
        Effect.gen(function* () {
          const disposition = yield* port(() => session[kind](p.text, opts?.images));
          if (disposition === "queued" && settled) {
            // pi has queued it, and announced it (`queue_update`), on a run that takes nothing in any more. Emptying
            // the queue tells the observation plane so, which would otherwise report the refused prompt pending.
            session.clearQueue();
            return yield* Effect.fail(alreadySettled());
          }
          return disposition;
        }),
      );
    };
    const controls: RunControls = {
      steer: (p) => enqueue(p, "steer"),
      followUp: (p) => enqueue(p, "followUp"),
      abort: () =>
        command((session) =>
          Effect.gen(function* () {
            abortsInFlight++;
            yield* port(() => session.abort()).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  abortSucceeded = true;
                }),
              ),
              Effect.ensuring(
                Effect.sync(() => {
                  abortsInFlight--;
                }),
              ),
            );
          }),
        ),
    };

    const execute = Effect.gen(function* () {
      yield* acquireSessionLease(lease, scope.session);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          settled = true;
          observe({ type: "run_settled", timestamp: Date.now(), runId, data: outcome ?? { status: "aborted" } });
        }),
      );
      // Admission precedes binding so a racing control command waits on this run's readiness gate.
      observe({ type: "run_started", timestamp: Date.now(), runId, data: {} }, controls);
      const session = yield* acquireSession(
        sessionFactory,
        scope.session,
        scope.parentSession === undefined
          ? undefined
          : {
              parentSession: scope.parentSession,
              ...(scope.branchHints !== undefined ? { branchHints: scope.branchHints } : {}),
            },
      );
      let finalAssistant: AssistantMessage | undefined;
      let runStarted = false;
      let extensionFailure: string | undefined;
      let streamedAnswer = false;
      let retriedAfterAnswer: string | undefined;
      let eventFailure: PortFailure | undefined;
      const stop = () => {
        void Effect.runPromise(portCleanup("event-fault abort", () => session.abort()));
      };
      yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
            session.subscribe((event) => {
              if (retriedAfterAnswer !== undefined || eventFailure) return;
              try {
                if (event.type === "agent_start") runStarted = true;
                // Compaction rewrites session history; the event's assistant message is the turn's fact.
                if (event.type === "message_end" && event.message.role === "assistant") {
                  finalAssistant = event.message as AssistantMessage;
                  for (const diagnostic of finalAssistant.diagnostics ?? []) {
                    log.warn(
                      `[fastagent] provider diagnostic ${diagnostic.type} (${finalAssistant.provider}/${finalAssistant.model}, session ${scope.session}, run ${runId})`,
                    );
                  }
                }
                if (event.type === "compaction_end" && event.reason !== "manual") {
                  const status = event.aborted ? "aborted" : event.errorMessage ? "failed" : "completed";
                  const emit = event.errorMessage && !event.aborted ? log.warn : log.debug;
                  emit(
                    `[fastagent] automatic compaction ${event.reason} (session ${scope.session}, run ${runId}): ${status}`,
                  );
                }
                if (event.type === "auto_retry_start" && streamedAnswer) {
                  retriedAfterAnswer = event.errorMessage;
                  // Pi installs the retry controller after emitting this event.
                  queueMicrotask(stop);
                  return;
                }
                const rich = toSessionEvent(event, runId);
                observe(rich);
                if (!rich) return;
                const projected = project(rich);
                if (!projected) return;
                if (projected.type === "text" || projected.type === "thinking") streamedAnswer = true;
                if (projected.type === "tool_progress") {
                  const unread = unreadProgress.get(projected.id);
                  if (unread) {
                    unread.text = projected.text;
                    return;
                  }
                  unreadProgress.set(projected.id, projected);
                }
                Queue.offerUnsafe(queue, projected);
              } catch (error) {
                eventFailure = new PortFailure(error);
                queueMicrotask(stop);
              }
            }),
          catch: (error) => new PortFailure(error),
        }),
        (unsubscribe) => portCleanup("unsubscribe", unsubscribe),
      );
      // pi swallows a failing extension command, and a turn an extension failed to start, into its error channel;
      // both are work this run owes its caller, so the run reports them.
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          session.extensionRunner.onError((error) => {
            if (OWED_BY_THE_RUN.has(error.event))
              extensionFailure ??= `${error.event} failed (${error.extensionPath}): ${error.error}`;
          }),
        ),
        (unsubscribe) => Effect.sync(unsubscribe),
      );
      yield* reportUserMessages(session, (data) =>
        observe({ type: "user_message", timestamp: Date.now(), runId, data }),
      );
      const extensionTurns = trackExtensionTurns(session);
      // Completing the gate can run waiting controls synchronously; their queue events must be observed.
      yield* Deferred.succeed(bound, session);
      const promptOptions = yield* port(() => toPiPromptOptions(prompt, "prompt"));
      if (eventFailure) return yield* Effect.fail(eventFailure);
      // Whether an extension could take this input instead of the model (a command, or an `input` handler): only
      // then may a prompt settle with no model run and still have done its job.
      const extensionMayTakeInput =
        session.extensionRunner.getRegisteredCommands().length > 0 || session.extensionRunner.hasHandlers("input");
      yield* portAbort(
        "prompt",
        async () => {
          await session.prompt(prompt.text, promptOptions);
          // An extension command returns from `prompt()` as soon as its handler does, and a turn it started may not
          // have begun yet, so idleness alone proves nothing. This run owns those turns until they settle, and any
          // turn they start in turn.
          do {
            await Promise.allSettled([...extensionTurns]);
            await session.waitForIdle();
          } while (extensionTurns.size > 0);
        },
        () => session.abort(),
      );
      if (eventFailure) return yield* Effect.fail(eventFailure);
      if (extensionFailure !== undefined)
        return { type: "failed", details: extensionFailure, retryable: false } as const;
      if (retriedAfterAnswer !== undefined)
        return { type: "failed", details: retriedAfterAnswer, retryable: true } as const;
      if (finalAssistant) return toTerminal(finalAssistant);
      // No model run at all: an extension took the input (a command, or an `input` handler) and did its work.
      if (!runStarted && extensionMayTakeInput) return { type: "completed" } as const;
      return {
        type: "failed",
        details: "the engine settled the run without ending an assistant message",
        retryable: false,
      } as const;
    }).pipe(Effect.onError((cause) => Deferred.failCause(bound, cause)));

    const work = Effect.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          const terminal = yield* execute.pipe(
            Effect.catchCause((cause) => {
              const error = portError(cause);
              return Effect.succeed(
                error instanceof SessionBusy
                  ? ({
                      type: "failed",
                      details: "session busy: a turn is already in flight for this session",
                      retryable: true,
                      code: SESSION_BUSY_CODE,
                    } as const)
                  : errorToTerminal(error),
              );
            }),
          );
          settled = true;
          Queue.offerUnsafe(
            queue,
            terminal.type === "failed" && (abortSucceeded || abortsInFlight > 0)
              ? { ...terminal, retryable: false, code: ABORTED_CODE }
              : terminal,
          );
          Queue.endUnsafe(queue);
          // Producer completion is earlier than consumer completion.
          yield* Deferred.await(consumed);
        }),
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            Queue.endUnsafe(queue);
          }),
        ),
      ),
      { signal: abort.signal },
    );

    const read = Queue.takeAll(queue).pipe(Effect.catchTag("Done", () => Effect.succeed([] as AgentEvent[])));
    try {
      for (;;) {
        const events = await Effect.runPromise(read);
        if (events.length === 0) return;
        for (const event of events) {
          if (wasCancelled()) return;
          if (event.type === "failed") {
            outcome =
              event.code === ABORTED_CODE
                ? { status: "aborted", error: { message: event.details, retryable: false } }
                : { status: "failed", error: { code: event.code, message: event.details, retryable: event.retryable } };
          } else if (event.type === "completed") outcome = { status: "completed" };
          // Handed over: the consumer owns it now, and the next status queues afresh.
          if (event.type === "tool_progress") unreadProgress.delete(event.id);
          yield event;
        }
      }
    } finally {
      Deferred.doneUnsafe(consumed, Effect.void);
      await Effect.runPromise(Fiber.await(work));
    }
  }

  return { invoke: (scope, prompt) => cancellableStream((hooks) => turn(scope, prompt, hooks)) };
}
