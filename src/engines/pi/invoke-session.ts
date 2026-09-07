/**
 * Pi's per-invoke binding over a durable session record. The execution scope owns the lease,
 * session and subscription until the consumer settles, even when the producer finishes first.
 * Events translate once into SessionEvent; AgentEvent is its projection.
 */
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import {
  ABORTED_CODE,
  SESSION_BUSY_CODE,
  type Agent,
  type AgentEvent,
  type Json,
  type Prompt,
  type Scope,
} from "../../agent.ts";
import type { RunSettledEvent, SessionEvent } from "../../session.ts";
import { type CancelHooks, cancellableStream } from "../../collect.ts";
import { log } from "../../log.ts";
import { toRetryScheduledEvent } from "./retry-event.ts";
import type { SessionInheritance } from "./session-inheritance.ts";
import {
  SessionBusy,
  SessionOperationError,
  acquireSession,
  acquireSessionLease,
  sessionCleanup,
  sessionFailure,
  sessionOperation,
  sessionWork,
} from "./session-effects.ts";
import {
  type Lease,
  type RunControls,
  type SessionObserver,
  errorToTerminal,
  inProcessLease,
  projectAgentEvent,
  toPiPromptOptions,
  toTerminal,
} from "./turn-kit.ts";

/** Open or create a record and bind a session. Inheritance applies only when creating the record. */
export type PiAgentSessionFactory = (sessionId: string, inherit?: SessionInheritance) => Promise<AgentSession>;

export interface CreatePiAgentFromSessionOptions {
  sessionFactory: PiAgentSessionFactory;
  /** Shared with control-plane writes; admission is synchronous and fail-fast. */
  lease?: Lease;
  /** Trusted observation tap; controls arrive with run_started, before session binding. */
  observer?: SessionObserver;
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
        data: { id: event.toolCallId, name: event.toolName, args: event.args as Json },
      };
    case "tool_execution_update":
      return {
        type: "tool_progress",
        timestamp: at,
        runId,
        data: { id: event.toolCallId, name: event.toolName, partialResult: event.partialResult as Json },
      };
    case "tool_execution_end":
      return {
        type: "tool_finished",
        timestamp: at,
        runId,
        data: { id: event.toolCallId, isError: event.isError, content: event.result as Json },
      };
    case "queue_update":
      return {
        type: "queue_changed",
        timestamp: at,
        runId,
        data: { steering: event.steering.length, followUp: event.followUp.length },
      };
    case "auto_retry_start":
    case "summarization_retry_scheduled":
      return toRetryScheduledEvent(event, runId);
    default:
      return null;
  }
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
    const bound = Deferred.makeUnsafe<AgentSession, SessionOperationError>();
    const abort = new AbortController();
    onCancelReady(() => abort.abort());
    const runId = crypto.randomUUID();
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
    const controls: RunControls = {
      steer: (p) =>
        Effect.runPromise(
          Effect.gen(function* () {
            const opts = yield* sessionOperation("prepare steering", () => toPiPromptOptions(p));
            const session = yield* ready;
            if (settled)
              return yield* Effect.fail(
                new SessionOperationError("steer", new Error("run already settled; the command cannot take effect")),
              );
            yield* sessionOperation("steer", () => session.steer(p.text, opts?.images));
          }),
        ),
      followUp: (p) =>
        Effect.runPromise(
          Effect.gen(function* () {
            const opts = yield* sessionOperation("prepare follow-up", () => toPiPromptOptions(p));
            const session = yield* ready;
            if (settled)
              return yield* Effect.fail(
                new SessionOperationError(
                  "follow-up",
                  new Error("run already settled; the command cannot take effect"),
                ),
              );
            yield* sessionOperation("follow-up", () => session.followUp(p.text, opts?.images));
          }),
        ),
      abort: () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const session = yield* ready;
            if (settled)
              return yield* Effect.fail(
                new SessionOperationError("abort", new Error("run already settled; the command cannot take effect")),
              );
            abortsInFlight++;
            yield* sessionOperation("abort", () => session.abort()).pipe(
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
      ).pipe(Effect.onExit((exit) => Deferred.done(bound, exit)));
      let finalAssistant: AssistantMessage | undefined;
      let streamedAnswer = false;
      let retriedAfterAnswer: string | undefined;
      let eventFailure: SessionOperationError | undefined;
      const stop = () => {
        void Effect.runPromise(sessionCleanup("abort", () => session.abort()));
      };
      yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
            session.subscribe((event) => {
              if (retriedAfterAnswer !== undefined || eventFailure) return;
              try {
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
                  // Pi installs the retry controller after emitting this event. Tool output alone is
                  // replay-safe: Pi resumes from persisted tool results, rather than running tools twice.
                  queueMicrotask(stop);
                  return;
                }
                const rich = toSessionEvent(event, runId);
                observe(rich);
                if (!rich) return;
                const projected = projectAgentEvent(rich);
                if (!projected) return;
                if (projected.type === "text" || projected.type === "thinking") streamedAnswer = true;
                Queue.offerUnsafe(queue, projected);
              } catch (error) {
                eventFailure = new SessionOperationError("event translation", error);
                queueMicrotask(stop);
              }
            }),
          catch: (error) => new SessionOperationError("subscribe", error),
        }),
        (unsubscribe) => sessionCleanup("unsubscribe", unsubscribe),
      );
      const promptOptions = yield* sessionOperation("prepare prompt", () => toPiPromptOptions(prompt));
      if (eventFailure) return yield* Effect.fail(eventFailure);
      yield* sessionWork(
        "prompt",
        () => session.prompt(prompt.text, promptOptions),
        () => session.abort(),
      );
      if (eventFailure) return yield* Effect.fail(eventFailure);
      return retriedAfterAnswer !== undefined
        ? ({ type: "failed", details: retriedAfterAnswer, retryable: true } as const)
        : finalAssistant
          ? toTerminal(finalAssistant)
          : ({
              type: "failed",
              details: "the engine settled the run without ending an assistant message",
              retryable: false,
            } as const);
    });

    const work = Effect.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          const terminal = yield* execute.pipe(
            Effect.catchCause((cause) => {
              const error = sessionFailure(cause);
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
          // Producer completion is earlier than consumer completion. Keep all resources until the
          // consumer has drained or cancelled, including when its terminal is still buffered.
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
