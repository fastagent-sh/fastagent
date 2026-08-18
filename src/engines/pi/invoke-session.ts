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
import { abortFirstIterator } from "../../collect.ts";
import { log } from "../../log.ts";
import { EventQueue, type Lease, errorToTerminal, inProcessLease, toPiPromptOptions, toTerminal } from "./invoke.ts";

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
      const ev = event.assistantMessageEvent;
      if (ev.type === "text_delta") return { type: "text", delta: ev.delta };
      if (ev.type === "thinking_delta") return { type: "thinking", delta: ev.delta };
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
 * a provider error and an abort both resolve normally), so the terminal comes from the last assistant
 * message's `stopReason` — the same read {@link toTerminal} performs on the harness path.
 *
 * Bounded to THIS turn (`from` = the message count before `prompt()`): the session is durable and
 * carries every previous turn, so an unbounded reverse scan would answer a run that produced nothing
 * with the PREVIOUS turn's assistant message — reporting `completed` for a turn that never ran.
 */
function terminalFromState(session: AgentSession, from: number): AgentEvent {
  const messages = session.state.messages;
  for (let i = messages.length - 1; i >= from; i--) {
    const message = messages[i];
    if (message?.role === "assistant") return toTerminal(message as AssistantMessage);
  }
  // Unreachable on a settled run: pi records an assistant message for every outcome, error and abort
  // included. Reaching it means the engine broke its own contract — say so with what the state held,
  // so the report names the engine rather than the turn.
  return {
    type: "failed",
    details:
      `the engine settled the run without an assistant message ` +
      `(${messages.length - from} message(s) this turn, last role: ${messages.at(-1)?.role ?? "none"})`,
    retryable: false,
  };
}

export function createPiAgentFromSession(options: CreatePiAgentFromSessionOptions): Agent {
  const { sessionFactory, lease = inProcessLease() } = options;

  function invoke(scope: Scope, prompt: Prompt): AsyncIterable<AgentEvent> {
    // The cancellation door (SPEC MUST 3), armed once the session exists; the latch covers a consumer
    // that walks away while the session is still being built. Same protocol as the harness L0.
    let externalCancel: (() => void) | undefined;
    let cancelled = false;
    const iterator = abortFirstIterator(
      turn(
        scope,
        prompt,
        (cancel) => {
          externalCancel = cancel;
        },
        () => cancelled,
      ),
      () => {
        cancelled = true;
        externalCancel?.();
      },
    );
    return { [Symbol.asyncIterator]: () => iterator };
  }

  async function* turn(
    scope: Scope,
    prompt: Prompt,
    onCancelReady: (cancel: () => void) => void,
    wasCancelled: () => boolean,
  ): AsyncGenerator<AgentEvent> {
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
        onCancelReady(() => {
          void session.abort().catch(() => {});
        });
        const queue = new EventQueue<AgentEvent>();
        const unsub = session.subscribe((event) => {
          const projected = toAgentEvent(event);
          if (projected) queue.push(projected);
        });
        try {
          // Everything the model call needs, resolved BEFORE the latch is read: the door armed above
          // only stops a RUNNING session, so a consumer who walks away while the session is being
          // built or its images resized would knock on an idle one and then have the turn start
          // anyway. One gate, placed after the last await before the call, covers both windows.
          //
          // Its own failure is a turn failure, not an iteration failure (MUST 2): resolving options
          // lazy-loads the image pipeline and re-encodes every attachment, so it can throw before any
          // engine work exists to fail.
          let options: Awaited<ReturnType<typeof toPiPromptOptions>>;
          try {
            options = await toPiPromptOptions(prompt);
          } catch (error) {
            yield errorToTerminal(error);
            return;
          }
          if (wasCancelled()) {
            await session.abort().catch(() => {});
            return;
          }
          const before = session.state.messages.length;
          const run = session.prompt(prompt.text, options);
          yield* queue.drainUntil(run);
          let terminal: AgentEvent;
          try {
            await run;
            terminal = terminalFromState(session, before);
          } catch (error) {
            terminal = errorToTerminal(error);
          }
          yield terminal;
        } finally {
          unsub();
        }
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

  return { invoke };
}
