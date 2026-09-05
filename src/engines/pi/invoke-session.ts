/**
 * THE L0: pi's `AgentSession`, one per invoke, over the same durable record —
 * [conformance-levels.md](../../../docs/design/conformance-levels.md) §2's `per-invoke` posture.
 * Build a session, run one turn, dispose; continuity lives in the record, never in this process.
 *
 * Why this class: pi 0.84 replaced `AgentHarness` with an unimplemented lane-based skeleton, and pi
 * does not consume that class itself — its TUI, RPC and SDK all run on `AgentSession`. Being the
 * sole consumer of a surface nobody dogfoods is a position, not an architecture.
 *
 * Events are translated ONCE, into the rich `SessionEvent` vocabulary the observation plane speaks;
 * the SPEC stream is a projection of that (`docs/design/session-control.md` §6 — one translation
 * plus one projection, never two parallel ones).
 *
 * Two disciplines this file exists to hold:
 * - the turn's outcome comes from the EVENT STREAM, never from an index into session state, which
 *   compaction and overflow recovery both rewrite mid-turn;
 * - `run_started` is published BEFORE the session is bound, so a dispatch racing the build queues on
 *   the run's controls instead of finding no run.
 */
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { SessionInheritance } from "./session-inheritance.ts";
import type { AssistantMessage } from "@earendil-works/pi-ai";
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
import { toRetryScheduledEvent } from "./retry-event.ts";
import { type CancelHooks, cancellableStream } from "../../collect.ts";
import { log } from "../../log.ts";
import {
  EventQueue,
  type Lease,
  type RunControls,
  type SessionObserver,
  errorToTerminal,
  inProcessLease,
  projectAgentEvent,
  toPiPromptOptions,
  toTerminal,
} from "./turn-kit.ts";

/** Open-or-create the session behind `sessionId` and bind an `AgentSession` to it, per invoke.
 *  `inherit` reaches the CREATE path only — an existing session ignores it. */
export type PiAgentSessionFactory = (sessionId: string, inherit?: SessionInheritance) => Promise<AgentSession>;

export interface CreatePiAgentFromSessionOptions {
  sessionFactory: PiAgentSessionFactory;
  /** Single-writer lease. Defaults to the in-process per-session fail-fast lease. */
  lease?: Lease;
  /** Observation-plane tap: every rich event of every run, plus the run's live {@link RunControls}
   *  on `run_started`. Optional; the SPEC stream is identical with or without it. */
  observer?: SessionObserver;
}

/**
 * pi session events into the rich `SessionEvent` vocabulary — the SINGLE translation point. Events
 * with no vocabulary yet (agent_start, turn_start, entry_appended, …) are dropped.
 *
 * `auto_retry_start` reports as a `retry_scheduled` with `operation: "assistant"`: pi retries a
 * failed ANSWER request itself, which the summarization-only cases of that vocabulary predate.
 */
function toSessionEvent(event: AgentSessionEvent, runId: string): SessionEvent | null {
  const at = Date.now();
  switch (event.type) {
    case "message_start":
      // Assistant streaming only — a user/toolResult message is not a live message boundary.
      if (event.message.role !== "assistant") return null;
      return { type: "message_started", timestamp: at, runId, data: {} };
    case "message_update": {
      // An empty delta is not output: it moves no consumer's state, and treating it as output would
      // spend the silent window that auto-retry is allowed to use (see runOnSession).
      const ev = event.assistantMessageEvent;
      if (ev.type === "text_delta") {
        return ev.delta === ""
          ? null
          : { type: "message_delta", timestamp: at, runId, data: { channel: "text", delta: ev.delta } };
      }
      if (ev.type === "thinking_delta") {
        return ev.delta === ""
          ? null
          : { type: "message_delta", timestamp: at, runId, data: { channel: "thinking", delta: ev.delta } };
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

/**
 * The turn's outcome. `prompt()` resolves void and never throws for an engine-side failure (measured:
 * a provider error and an abort both resolve normally), so the terminal comes from the assistant
 * message the run ended on.
 *
 * That message is taken from the EVENT STREAM, not from `session.state.messages`. Session state is
 * mutable mid-turn: compaction replaces the array, and overflow recovery splices the last assistant
 * message out of it outright (`state.messages = messages.slice(0, -1)`). Any index into it is a
 * turn boundary that the engine is free to invalidate, while a `message_end` payload is a fact that
 * already happened. Auto-compaction runs its own model call outside the agent's event stream, so it
 * cannot masquerade as the turn's answer here.
 */
const ENGINE_PRODUCED_NOTHING: AgentEvent = {
  // Unreachable on a settled run: pi ends every outcome, error and abort included, with an assistant
  // message. Reaching it means the engine broke its own contract — name the engine, not the turn.
  type: "failed",
  details: "the engine settled the run without ending an assistant message",
  retryable: false,
};

export function createPiAgentFromSession(options: CreatePiAgentFromSessionOptions): Agent {
  const { sessionFactory, lease = inProcessLease(), observer } = options;

  async function* turn(
    scope: Scope,
    prompt: Prompt,
    { onCancelReady, wasCancelled }: CancelHooks,
  ): AsyncGenerator<AgentEvent> {
    const release = lease.tryAcquire(scope.session);
    if (!release) {
      // Rejected BEFORE acceptance: no run exists, so the observer sees nothing (replay-safe).
      yield {
        type: "failed",
        details: "session busy: a turn is already in flight for this session",
        retryable: true,
        code: SESSION_BUSY_CODE,
      };
      return;
    }
    // The run exists from here: exactly one run_started, exactly one run_settled. The settlement is
    // emitted in the outer finally, immediately before the lease releases, so the observation
    // plane's "running" window equals the lease window — state() must never read idle while a new
    // invoke would still be rejected session_busy. A run with no recorded outcome was cancelled by
    // the caller (SPEC: cancellation has no terminal event), which settles as aborted.
    const runId = crypto.randomUUID();
    let outcome: RunSettledEvent["data"] | undefined;
    const observe = (event: SessionEvent | null, run?: RunControls): void => {
      if (!event || !observer) return;
      try {
        observer(scope.session, event, run);
      } catch (error) {
        // The observation plane must never break the data plane; a broken hub is its own problem.
        log.warn(`[fastagent] session observer threw (event ${event.type}): ${String(error)}`);
      }
    };

    // run_started is published BEFORE the session is built, so no early event can outrun the
    // registration — which means the controls have to await the build rather than reject during it:
    // a dispatch that races it simply queues on the freshly bound session. A build failure rejects
    // the gate, so a pending dispatch learns why instead of hanging.
    let sessionReady!: (session: AgentSession) => void;
    let sessionFailed!: (error: unknown) => void;
    const bound = new Promise<AgentSession>((resolve, reject) => {
      sessionReady = resolve;
      sessionFailed = reject;
    });
    bound.catch(() => {}); // observed through the controls only when a dispatch actually happens

    // Stale-controls guard: after settlement pi's steer()/followUp()/abort() would still resolve
    // (they queue onto a session about to be disposed), which is a silent acceptance of a command
    // that can never take effect. The check and the engine call share one synchronous block — pi
    // enqueues at method entry, so a check behind its own await would only shrink the race.
    let settled = false;
    const settledError = () => new Error("run already settled; the command cannot take effect");
    // Aborted classification has two sources, either sufficient: pi's own stopReason "aborted", and
    // control-plane INTENT — providers do not uniformly attribute an aborted stream, so an abort
    // that was still in flight when the terminal arrived counts too.
    let abortsInFlight = 0;
    let abortSucceeded = false;
    const controls: RunControls = {
      async steer(p: Prompt) {
        const opts = await toPiPromptOptions(p);
        const session = await bound;
        if (settled) throw settledError();
        await session.steer(p.text, opts?.images);
      },
      async followUp(p: Prompt) {
        const opts = await toPiPromptOptions(p);
        const session = await bound;
        if (settled) throw settledError();
        await session.followUp(p.text, opts?.images);
      },
      async abort() {
        const session = await bound;
        if (settled) throw settledError();
        abortsInFlight++;
        try {
          await session.abort();
          abortSucceeded = true;
        } finally {
          abortsInFlight--;
        }
      },
    };
    observe({ type: "run_started", timestamp: Date.now(), runId, data: {} }, controls);

    try {
      let session: AgentSession;
      try {
        // The scope's lineage reaches the store's CREATE path only — an existing session opens
        // exactly as before, whatever the scope names.
        session = await sessionFactory(
          scope.session,
          scope.parentSession === undefined
            ? undefined
            : {
                parentSession: scope.parentSession,
                ...(scope.branchHints !== undefined ? { branchHints: scope.branchHints } : {}),
              },
        );
        sessionReady(session);
      } catch (error) {
        // Setup failures (session open, auth, a broken definition) are EVENTS, never throws
        // (MUST 2) — and they settle the run as failed: an unrecorded outcome means the caller
        // cancelled, which this is not.
        sessionFailed(error); // a pending dispatch learns the run cannot take commands
        const terminal = errorToTerminal(error);
        outcome = { status: "failed", error: { message: terminal.details, retryable: terminal.retryable } };
        settled = true;
        yield terminal;
        return;
      }
      try {
        const abort = () => session.abort().catch(() => {});
        onCancelReady(() => void abort());
        const queue = new EventQueue<AgentEvent>();
        let finalAssistant: AssistantMessage | undefined;
        /** Whether any of THIS attempt's answer has been streamed — the only output a retry duplicates. */
        let streamedAnswer = false;
        /** Set when a retry is refused because the answer already streamed — carries the ending error. */
        let retriedAfterAnswer: string | undefined;
        const unsub = session.subscribe((event) => {
          if (retriedAfterAnswer !== undefined) return; // decided; the retry's output is not ours
          if (event.type === "message_end" && event.message.role === "assistant") {
            finalAssistant = event.message as AssistantMessage;
            // Details can contain provider payloads; keep those in the journal, not server logs.
            for (const diagnostic of finalAssistant.diagnostics ?? []) {
              log.warn(
                `[fastagent] provider diagnostic ${diagnostic.type} (${finalAssistant.provider}/${finalAssistant.model}, session ${scope.session}, run ${runId})${diagnostic.error ? `: ${diagnostic.error.message}` : ""}`,
              );
            }
          }
          if (event.type === "compaction_end" && event.reason !== "manual") {
            const status = event.aborted ? "aborted" : (event.errorMessage ?? "completed");
            const emit = event.errorMessage && !event.aborted ? log.warn : log.debug;
            emit(
              `[fastagent] automatic compaction ${event.reason} (session ${scope.session}, run ${runId}): ${status}`,
            );
          }
          // pi retries a failed assistant request by DISCARDING that attempt's assistant message and
          // asking again. Everything the turn achieved before it survives — executed tools keep
          // their persisted results, and the retry resumes from them — so the only thing a retry can
          // duplicate is answer text already streamed, which SPEC deltas cannot retract. Refuse it
          // exactly there: refusing on tool events instead would push the retry out to the CALLER,
          // who can only re-run the whole prompt and execute the tool a second time.
          if (event.type === "auto_retry_start" && streamedAnswer) {
            retriedAfterAnswer = event.errorMessage;
            // Not synchronously: pi emits this event BEFORE creating the controller that makes its
            // backoff abortable, so an abort from inside the listener would find nothing to cancel
            // and the turn would still pay the delay and burn a provider call on a discarded answer.
            queueMicrotask(() => void abort());
            return;
          }
          const rich = toSessionEvent(event, runId);
          if (!rich) return;
          observe(rich);
          const projected = projectAgentEvent(rich);
          if (!projected) return;
          if (projected.type === "text" || projected.type === "thinking") streamedAnswer = true;
          queue.push(projected);
        });
        try {
          // Resolving prompt options lazy-loads the image pipeline and re-encodes every attachment,
          // so it both takes time and can throw before any engine work exists to fail. Hence the two
          // guards, in this order and no earlier: its failure is a turn failure (MUST 2), and the
          // latch has to be read after the LAST await before the call — the door armed above only
          // stops a RUNNING session, so a consumer who walked away during the build or the resize
          // would knock on an idle one and have the turn start anyway.
          let promptOptions: Awaited<ReturnType<typeof toPiPromptOptions>>;
          try {
            promptOptions = await toPiPromptOptions(prompt);
          } catch (error) {
            const terminal = errorToTerminal(error);
            outcome = { status: "failed", error: { message: terminal.details, retryable: terminal.retryable } };
            settled = true;
            yield terminal;
            return;
          }
          if (wasCancelled()) {
            settled = true;
            await abort();
            return; // cancelled: the outer finally settles it as aborted
          }
          const run = session.prompt(prompt.text, promptOptions);
          yield* queue.drainUntil(run);
          let terminal: AgentEvent;
          try {
            await run;
            terminal =
              retriedAfterAnswer !== undefined
                ? { type: "failed", details: retriedAfterAnswer, retryable: true }
                : finalAssistant
                  ? toTerminal(finalAssistant)
                  : ENGINE_PRODUCED_NOTHING;
          } catch (error) {
            terminal = errorToTerminal(error);
          }
          if ((abortSucceeded || abortsInFlight > 0) && terminal.type === "failed") {
            terminal = { type: "failed", details: terminal.details, retryable: false, code: ABORTED_CODE };
          }
          if (terminal.type === "failed") {
            outcome =
              terminal.code === ABORTED_CODE
                ? // Carry the detail: an independent error that raced an accepted abort must stay
                  // diagnosable in the settlement, which is what audit consumers read.
                  { status: "aborted", error: { message: terminal.details, retryable: false } }
                : {
                    status: "failed",
                    error: { code: terminal.code, message: terminal.details, retryable: terminal.retryable },
                  };
          } else {
            outcome = { status: "completed" };
          }
          // Commands become ineffective the moment the run resolved — not at the outer finally,
          // which sits behind a consumer-paced `yield`.
          settled = true;
          yield terminal;
        } finally {
          settled = true;
          unsub();
        }
      } finally {
        // NO session_shutdown here, deliberately. A per-invoke session makes one look right, but the
        // extension INSTANCE it would tear down is not per-invoke: extensions belong to the agent's
        // assembly and every turn shares one. Emitting a shutdown per turn had a finished
        // turn clearing a timer a concurrent turn had just opened (measured, and pinned in
        // definition-extensions.test.ts). The lifecycle has to match the instance, not the session
        // wrapper: one agent, one instance, no per-turn teardown. Extensions that need per-turn
        // cleanup do it in the tool or handler that opened the resource.
        try {
          session.dispose();
        } catch (error) {
          log.warn(`[fastagent] session dispose failed during cleanup: ${String(error)}`);
        }
      }
    } finally {
      settled = true;
      observe({ type: "run_settled", timestamp: Date.now(), runId, data: outcome ?? { status: "aborted" } });
      release(); // after the settlement, so the next invoke for this session cannot outrun it
    }
  }

  return { invoke: (scope, prompt) => cancellableStream((hooks) => turn(scope, prompt, hooks)) };
}
