/**
 * L0 for the `session` ENGINE CLASS: an Agent whose every turn builds a fresh pi-coding-agent
 * `AgentSession` over the session's durable record and discards it when the turn ends.
 *
 * Same state locality as the harness L0 (`invoke.ts`) — per-invoke, so SPEC MUST 6 holds and the
 * record is the only continuity — but a different engine surface: extensions, `/name` dispatch,
 * branch operations. The two axes are independent; see design/conformance-levels.md.
 *
 * Why per-invoke is affordable HERE, where a resident `AgentSession` was assumed: the expensive half
 * of that class is the `ResourceLoader` (extension modules, skills), which is built ONCE with the
 * assembly and shared across turns. What is per-turn is binding a session object to a record.
 *
 * This module owns the turn mechanism only. The assembly that produces a {@link PiSessionFactory}
 * (models, auth, tools, definition, extensions) is a caller's concern, exactly as
 * `piHarnessFactory` is for the harness class.
 */
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentEvent, Agent, Json, Prompt, Scope } from "../../agent.ts";
import { SESSION_BUSY_CODE } from "../../agent.ts";
import { abortFirstIterator } from "../../collect.ts";
import { log } from "../../log.ts";
import { EventQueue, type Lease, errorToTerminal, inProcessLease, toTerminal } from "./invoke.ts";

/**
 * Build a session object bound to `sessionId`'s durable record. Called once per invoke; the returned
 * object is discarded when the turn ends, so an implementation must NOT cache it across turns (that
 * would be the resident level, with a different bill).
 */
export interface CreatePiAgentFromSessionOptions {
  sessionFactory: (sessionId: string) => Promise<AgentSession>;
  /** One in-flight turn per session, like the harness L0. A collision fails `session_busy`. */
  lease?: Lease;
}

/** pi's session-class event → the Agent Handler vocabulary. `null` = nothing to project. */
function projectSessionEvent(event: AgentSessionEvent): AgentEvent | null {
  switch (event.type) {
    case "message_update": {
      // The delta channel: pi reports the accumulated message plus the event that changed it.
      const e = (event as { assistantMessageEvent?: { type?: string; delta?: string } }).assistantMessageEvent;
      if (!e || typeof e.delta !== "string" || e.delta === "") return null;
      if (e.type === "thinking_delta" || e.type === "thinking") return { type: "thinking", delta: e.delta };
      if (e.type === "text_delta" || e.type === "text") return { type: "text", delta: e.delta };
      return null;
    }
    case "tool_execution_start":
      return {
        type: "tool_started",
        id: event.toolCallId,
        name: event.toolName,
        args: (event.args ?? null) as Json,
      };
    case "tool_execution_end":
      return {
        type: "tool_ended",
        id: event.toolCallId,
        isError: event.isError,
        content: (event.result ?? null) as Json,
      };
    case "auto_retry_start":
      return {
        type: "retrying",
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        reason: event.errorMessage,
      };
    default:
      // Everything else is either session-class bookkeeping (entry_appended, queue_update) or
      // richer-plane material the control plane will project separately. Terminal events are NOT
      // derived here — the turn's outcome comes from the settled assistant message.
      return null;
  }
}

/** The assistant message a settled turn ended on, for terminal classification. */
function lastAssistant(event: AgentSessionEvent): Parameters<typeof toTerminal>[0] | undefined {
  if (event.type !== "agent_end") return undefined;
  const messages = event.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "assistant") return m as Parameters<typeof toTerminal>[0];
  }
  return undefined;
}

/**
 * The `session`-class L0. Mirrors `createPiAgentFromHarness`'s discipline: failures are `failed`
 * events (never thrown mid-iteration), exactly one terminal, and a consumer break aborts in-flight
 * engine work.
 */
export function createPiAgentFromSession(options: CreatePiAgentFromSessionOptions): Agent {
  const { sessionFactory, lease = inProcessLease() } = options;

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
        // Setup failures (record open, auth, extension binding) are EVENTS, never throws.
        yield errorToTerminal(error);
        return;
      }
      // Arm the cancellation door before any model work, then honour a cancel that arrived while
      // the session was still being built (the latch) — the same ordering the harness L0 uses.
      onCancelReady(() => {
        void session.abort().catch(() => {});
      });
      if (wasCancelled()) {
        await session.abort().catch((error: unknown) => {
          log.warn(`[fastagent] session abort failed during cleanup: ${String(error)}`);
        });
        return;
      }

      const queue = new EventQueue<AgentEvent>();
      let settled: Parameters<typeof toTerminal>[0] | undefined;
      let sawEnd = false;
      const unsub = session.subscribe((event) => {
        if (event.type === "agent_end") {
          // `willRetry` means pi will run again for this same prompt — not a settle.
          if (!(event as { willRetry?: boolean }).willRetry) {
            sawEnd = true;
            settled = lastAssistant(event);
          }
          return;
        }
        const projected = projectSessionEvent(event);
        if (projected) queue.push(projected);
      });
      try {
        // prompt() resolves when the turn is accepted-and-run; waitForIdle() closes the window in
        // which pi is still draining its own queues (a follow-up, a retry), so the terminal below
        // describes the whole activity window rather than the first response inside it.
        const run = (async () => {
          await session.prompt(prompt.text);
          await session.waitForIdle();
        })();
        yield* queue.drainUntil(run);
        let terminal: AgentEvent;
        try {
          await run;
          // No settled assistant message means the turn produced no model response at all (an
          // extension command handled the input, or pi ended without one) — a completed turn with
          // nothing to classify, not a failure.
          terminal = settled ? toTerminal(settled) : { type: "completed" };
        } catch (error) {
          terminal = errorToTerminal(error);
        }
        void sawEnd;
        yield terminal;
      } finally {
        try {
          unsub();
        } catch (error) {
          log.warn(`[fastagent] session unsubscribe failed during cleanup: ${String(error)}`);
        }
        // Fresh-session discipline: the object dies with the turn. Aborting first releases any work
        // still in flight after a consumer break.
        try {
          await session.abort();
        } catch (error) {
          log.warn(`[fastagent] session abort failed during cleanup: ${String(error)}`);
        }
      }
    } finally {
      release();
    }
  }

  return {
    invoke(scope: Scope, prompt: Prompt): AsyncIterable<AgentEvent> {
      let externalCancel: (() => void) | undefined;
      let cancelled = false;
      const gen = turn(
        scope,
        prompt,
        (cancel) => {
          externalCancel = cancel;
        },
        () => cancelled,
      );
      const iterator = abortFirstIterator(gen, () => {
        cancelled = true;
        externalCancel?.();
      });
      return {
        [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
          return iterator;
        },
      };
    },
  };
}
