/**
 * L0 over pi-coding-agent's `AgentSession`, in the `per-invoke` state locality
 * ([conformance-levels.md](../../../docs/design/conformance-levels.md) §2, top-right cell): build a
 * session per invoke over the SAME durable jsonl, run one turn, dispose.
 *
 * Why this exists next to {@link createPiAgentFromHarness}: pi 0.84 replaced `AgentHarness` with an
 * unimplemented lane-based skeleton, and pi does not consume that class itself — its TUI, RPC and SDK
 * all run on `AgentSession`. This is the executable proof that the SPEC's four Agent-side MUSTs hold
 * on the class pi actually maintains (test/conformance-session.test.ts).
 *
 * SCOPE, deliberately narrow: the concurrency floor, the event stream, and cancellation. The
 * observation plane (SessionObserver / RunControls / the rich `SessionEvent` vocabulary), the tool
 * activation bridge, auto-compaction and session inheritance are NOT wired.
 *
 * WHICH L0 SERVES: {@link createPiAgentFromHarness}, still — this one is reachable only from its
 * conformance test (deliberately absent from `src/pi.ts`), because a serving path needs the pieces
 * above. Its one known debt is {@link toAgentEvent}: translating pi events straight to SPEC
 * `AgentEvent`s is the second parallel translation `docs/design/session-control.md` §6 forbids. It
 * retires the moment this L0 grows the observation plane — the rich `SessionEvent` layer comes back
 * with it, and the harness L0 goes away.
 */
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SESSION_BUSY_CODE, type Agent, type AgentEvent, type Json, type Prompt, type Scope } from "../../agent.ts";
import { type CancelHooks, cancellableStream } from "../../collect.ts";
import { log } from "../../log.ts";
import { EventQueue, type Lease, errorToTerminal, inProcessLease, toPiPromptOptions, toTerminal } from "./turn-kit.ts";

/** Open-or-create the session behind `sessionId` and bind an `AgentSession` to it, per invoke. */
export type PiAgentSessionFactory = (sessionId: string) => Promise<AgentSession>;

export interface CreatePiAgentFromSessionOptions {
  sessionFactory: PiAgentSessionFactory;
  /** Single-writer lease. Defaults to the in-process per-session fail-fast lease. */
  lease?: Lease;
}

/**
 * SPEC events from pi's session stream. `auto_retry_start` has no harness counterpart: an
 * `AgentSession` retries a failed assistant request itself, which the SPEC already has a word for.
 */
function toAgentEvent(event: AgentSessionEvent): AgentEvent | null {
  switch (event.type) {
    case "message_update": {
      // An empty delta is not output: it moves no consumer's state, and treating it as output would
      // spend the silent window that auto-retry is allowed to use (see runOnSession).
      const ev = event.assistantMessageEvent;
      if (ev.type === "text_delta") return ev.delta === "" ? null : { type: "text", delta: ev.delta };
      if (ev.type === "thinking_delta") return ev.delta === "" ? null : { type: "thinking", delta: ev.delta };
      return null;
    }
    case "tool_execution_start":
      return { type: "tool_started", id: event.toolCallId, name: event.toolName, args: event.args as Json };
    case "tool_execution_end":
      return { type: "tool_ended", id: event.toolCallId, isError: event.isError, content: event.result as Json };
    case "auto_retry_start":
      return {
        type: "retrying",
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        reason: event.errorMessage,
      };
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
function engineProducedNothing(): AgentEvent {
  // Unreachable on a settled run: pi ends every outcome, error and abort included, with an assistant
  // message. Reaching it means the engine broke its own contract — name the engine, not the turn.
  return {
    type: "failed",
    details: "the engine settled the run without ending an assistant message",
    retryable: false,
  };
}

export function createPiAgentFromSession(options: CreatePiAgentFromSessionOptions): Agent {
  const { sessionFactory, lease = inProcessLease() } = options;

  /** Own the session's lifetime: one writer, built here, disposed here whatever the turn did. */
  async function* turn(scope: Scope, prompt: Prompt, hooks: CancelHooks): AsyncGenerator<AgentEvent> {
    const release = lease.tryAcquire(scope.session);
    if (!release) {
      yield {
        type: "failed",
        details: "session busy: a turn is already in flight for this session",
        retryable: true,
        code: SESSION_BUSY_CODE,
      };
      return;
    }
    try {
      let session: AgentSession;
      try {
        session = await sessionFactory(scope.session);
      } catch (error) {
        yield errorToTerminal(error); // setup failures are events, never throws (MUST 2)
        return;
      }
      try {
        yield* runOnSession(session, prompt, hooks);
      } finally {
        try {
          session.dispose();
        } catch (error) {
          log.warn(`[fastagent] session dispose failed during cleanup: ${String(error)}`);
        }
      }
    } finally {
      release();
    }
  }

  return { invoke: (scope, prompt) => cancellableStream((hooks) => turn(scope, prompt, hooks)) };
}

/** One turn on a session someone else owns: subscribe, prompt, stream, terminal. */
async function* runOnSession(
  session: AgentSession,
  prompt: Prompt,
  { onCancelReady, wasCancelled }: CancelHooks,
): AsyncGenerator<AgentEvent> {
  const abort = () => session.abort().catch(() => {});
  onCancelReady(() => void abort());
  const queue = new EventQueue<AgentEvent>();
  let finalAssistant: AssistantMessage | undefined;
  let emittedOutput = false;
  /** Set when a retry is refused because output already left — carries the error that ends the turn. */
  let retriedAfterOutput: string | undefined;
  const unsub = session.subscribe((event) => {
    if (retriedAfterOutput !== undefined) return; // the turn is decided; the retry's output is not ours
    if (event.type === "message_end" && event.message.role === "assistant") {
      finalAssistant = event.message as AssistantMessage;
    }
    // pi retries a failed assistant request by discarding the attempt and running another one. That
    // is free resilience while the turn is still silent, and corruption once it is not: SPEC deltas
    // are append-only and `retrying` cannot retract them, so the second attempt's answer would
    // arrive concatenated onto the failed one's half-sentence. Take the resilience in the silent
    // window; end the turn honestly outside it.
    if (event.type === "auto_retry_start" && emittedOutput) {
      retriedAfterOutput = event.errorMessage;
      // Not synchronously: pi emits this event BEFORE creating the controller that makes its backoff
      // abortable, so an abort from inside the listener would find nothing to cancel and the turn
      // would still pay the full delay and burn a provider call on an answer we must discard.
      queueMicrotask(() => void abort());
      return;
    }
    const projected = toAgentEvent(event);
    if (!projected) return;
    if (projected.type !== "retrying") emittedOutput = true;
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
      yield errorToTerminal(error);
      return;
    }
    if (wasCancelled()) {
      await abort();
      return;
    }
    const run = session.prompt(prompt.text, options);
    yield* queue.drainUntil(run);
    try {
      await run;
      yield retriedAfterOutput !== undefined
        ? { type: "failed", details: retriedAfterOutput, retryable: true }
        : finalAssistant
          ? toTerminal(finalAssistant)
          : engineProducedNothing();
    } catch (error) {
      yield errorToTerminal(error);
    }
  } finally {
    unsub();
  }
}
