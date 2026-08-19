/**
 * L0 over pi-coding-agent's `AgentSession`, in the `per-invoke` state locality
 * ([conformance-levels.md](../../../docs/design/conformance-levels.md) §2, top-right cell): build a
 * session per invoke over the SAME durable jsonl, run one turn, dispose.
 *
 * Why this exists next to {@link createPiAgentFromHarness}: pi 0.84 replaced `AgentHarness` with an
 * unimplemented lane-based skeleton, and pi does not consume that class itself — its TUI, RPC and SDK
 * all run on `AgentSession`. The serving path is moving here; the harness L0 is still the default.
 *
 * WHAT SERVES ON IT: `fastagent dev`/`start` under `FASTAGENT_ENGINE=session` (engine.ts), through
 * the directory opener, which is the only rung that can hand it durable session records. Real turns,
 * real definitions, real providers — not a test-only path.
 *
 * WHAT IT STILL REFUSES, loudly rather than by degrading: the harness engine's session store. It
 * throws naming the gap, because the alternative is durable continuity that silently is not.
 *
 * Events are translated ONCE, into the rich `SessionEvent` vocabulary the observation plane speaks;
 * the SPEC stream is a projection of that (`docs/design/session-control.md` §6 — one translation
 * plus one projection, never two parallel ones).
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
import type { RetryScheduledEvent, RunSettledEvent, SessionEvent } from "../../session.ts";
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
 * `auto_retry_start` has no harness counterpart: an `AgentSession` retries a failed assistant
 * request itself. It reports as a `retry_scheduled` with `operation: "assistant"`, a case the
 * harness could not produce and the vocabulary therefore did not have.
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
    case "auto_retry_start": {
      const retry: RetryScheduledEvent = {
        type: "retry_scheduled",
        timestamp: at,
        runId,
        data: {
          operation: "assistant",
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          error: event.errorMessage,
        },
      };
      return retry;
    }
    case "summarization_retry_scheduled": {
      const retry: RetryScheduledEvent = {
        type: "retry_scheduled",
        timestamp: at,
        runId,
        data: {
          operation: "compaction",
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          error: event.errorMessage,
        },
      };
      return retry;
    }
    default:
      return null;
  }
}

/**
 * The turn's outcome. `prompt()` resolves void and never throws for an engine-side failure (measured:
 * a provider error and an abort both resolve normally), so the terminal comes from the assistant
 * message the run ended on — the same read {@link toTerminal} performs on the harness path.
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

  /** Own the session's lifetime: one writer, built here, disposed here whatever the turn did. */
  async function* turn(scope: Scope, prompt: Prompt, hooks: CancelHooks): AsyncGenerator<AgentEvent> {
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
    // plane's "running" window equals the lease window - state() must never read idle while a new
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
      } catch (error) {
        yield errorToTerminal(error); // setup failures are events, never throws (MUST 2)
        return;
      }
      try {
        outcome = yield* runOnSession(session, prompt, hooks, runId, observe);
      } finally {
        try {
          session.dispose();
        } catch (error) {
          log.warn(`[fastagent] session dispose failed during cleanup: ${String(error)}`);
        }
      }
    } finally {
      observe({ type: "run_settled", timestamp: Date.now(), runId, data: outcome ?? { status: "aborted" } });
      release(); // after the settlement, so the next invoke for this session cannot outrun it
    }
  }

  return { invoke: (scope, prompt) => cancellableStream((hooks) => turn(scope, prompt, hooks)) };
}

/**
 * One turn on a session someone else owns: subscribe, prompt, stream, settle. Returns the run's
 * outcome so the caller can publish exactly one settlement around it.
 */
async function* runOnSession(
  session: AgentSession,
  prompt: Prompt,
  { onCancelReady, wasCancelled }: CancelHooks,
  runId: string,
  observe: (event: SessionEvent | null, run?: RunControls) => void,
): AsyncGenerator<AgentEvent, RunSettledEvent["data"] | undefined> {
  const abort = () => session.abort().catch(() => {});
  onCancelReady(() => void abort());
  const queue = new EventQueue<AgentEvent>();
  let finalAssistant: AssistantMessage | undefined;
  /** Whether any of THIS attempt's answer has been streamed — the only output a retry would duplicate. */
  let streamedAnswer = false;
  /** Set when a retry is refused because the answer already streamed — carries the error that ends it. */
  let retriedAfterAnswer: string | undefined;
  // Stale-controls guard: after settlement pi's steer()/followUp()/abort() would still resolve (they
  // queue onto a session about to be disposed), which is a silent acceptance of a command that can
  // never take effect. The check and the engine call share one synchronous block — pi enqueues at
  // method entry, so a check behind its own await would only shrink the race, not close it.
  let settled = false;
  const settledError = () => new Error("run already settled; the command cannot take effect");
  // Aborted classification has two sources, either sufficient: pi's own stopReason "aborted", and
  // control-plane INTENT — providers do not uniformly attribute an aborted stream, so an abort that
  // was still in flight when the terminal arrived counts too.
  let abortsInFlight = 0;
  let abortSucceeded = false;
  const controls: RunControls = {
    async steer(p: Prompt) {
      const opts = await toPiPromptOptions(p);
      if (settled) throw settledError();
      await session.steer(p.text, opts?.images);
    },
    async followUp(p: Prompt) {
      const opts = await toPiPromptOptions(p);
      if (settled) throw settledError();
      await session.followUp(p.text, opts?.images);
    },
    async abort() {
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
  const unsub = session.subscribe((event) => {
    if (retriedAfterAnswer !== undefined) return; // the turn is decided; the retry's output is not ours
    if (event.type === "message_end" && event.message.role === "assistant") {
      finalAssistant = event.message as AssistantMessage;
    }
    // pi retries a failed assistant request by DISCARDING that attempt's assistant message and asking
    // again. Everything the turn achieved before it survives — executed tools keep their persisted
    // results, and the retry resumes from them — so the only thing a retry can duplicate is answer
    // text this L0 already streamed, which SPEC deltas cannot retract. Refuse it exactly there:
    // refusing on tool events instead would push the retry out to the CALLER, who can only re-run the
    // whole prompt and execute the tool a second time.
    if (event.type === "auto_retry_start" && streamedAnswer) {
      retriedAfterAnswer = event.errorMessage;
      // Not synchronously: pi emits this event BEFORE creating the controller that makes its backoff
      // abortable, so an abort from inside the listener would find nothing to cancel and the turn
      // would still pay the full delay and burn a provider call on an answer we must discard.
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
    // Resolving prompt options lazy-loads the image pipeline and re-encodes every attachment, so it
    // both takes time and can throw before any engine work exists to fail. Hence the two guards, in
    // this order and no earlier: its failure is a turn failure (MUST 2), and the latch has to be read
    // after the LAST await before the call — the door armed above only stops a RUNNING session, so a
    // consumer who walked away during the build or the resize would knock on an idle one and have
    // the turn start anyway.
    let options: Awaited<ReturnType<typeof toPiPromptOptions>>;
    try {
      options = await toPiPromptOptions(prompt);
    } catch (error) {
      const terminal = errorToTerminal(error);
      settled = true;
      yield terminal;
      return { status: "failed", error: { message: terminal.details, retryable: terminal.retryable } };
    }
    if (wasCancelled()) {
      settled = true;
      await abort();
      return undefined; // cancelled: the caller settles it as aborted
    }
    const run = session.prompt(prompt.text, options);
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
    // Commands become ineffective the moment the run resolved — not at the caller's finally, which
    // sits behind a consumer-paced `yield`.
    settled = true;
    let settlement: RunSettledEvent["data"] = { status: "completed" };
    if (terminal.type === "failed") {
      settlement =
        terminal.code === ABORTED_CODE
          ? // Carry the detail: an independent error that raced an accepted abort must stay
            // diagnosable in the settlement, which is what audit consumers read.
            { status: "aborted", error: { message: terminal.details, retryable: false } }
          : {
              status: "failed",
              error: { code: terminal.code, message: terminal.details, retryable: terminal.retryable },
            };
    }
    yield terminal;
    return settlement;
  } finally {
    settled = true;
    unsub();
  }
}
