/**
 * TEMPORARY, removed once the built-in channels and the scheduler speak SPEC v1 themselves (step 4, PR 4b): the v0.1
 * `Agent` they were written against, over the v1 `Agent` the serve now runs. Every write goes through the v1 Agent,
 * so a session keeps one writer. It keeps v0.1's own rules: a caller that stops reading cancels the run (v0.1 MUST 3),
 * and a busy session queues a channel's message, so its only `session_busy` is a full queue.
 */
import {
  ABORTED_CODE,
  type AgentEvent,
  type Agent as LegacyAgent,
  MISSING_MODEL_CODE,
  SESSION_BUSY_CODE,
} from "./agent.ts";
import { forkThread } from "./channels/kit/thread-fork.ts";
import { log } from "./log.ts";
import { runText } from "./run-text.ts";
import { cancellableStream } from "./collect.ts";
import type { AgentError, InvokeEvent, InvokeRequest, Agent as ProtocolAgent, RunOutcome } from "./protocol.ts";

const LEGACY_CODES: Record<string, string> = { busy: SESSION_BUSY_CODE, missing_model: MISSING_MODEL_CODE };

const failedFrom = (error: AgentError): AgentEvent => ({
  type: "failed",
  details: error.message,
  retryable: error.retryable,
  code: LEGACY_CODES[error.code] ?? error.code,
});

function terminalOf(outcome: RunOutcome): AgentEvent {
  switch (outcome.status) {
    case "completed":
    case "max_tokens":
    case "intercepted":
      return { type: "completed" };
    case "canceled":
      return { type: "failed", details: `the run was canceled (${outcome.by})`, retryable: false, code: ABORTED_CODE };
    case "interrupted":
      return { type: "failed", details: "the run was interrupted", retryable: true };
    case "failed":
      return failedFrom(outcome.error);
  }
}

/**
 * The scheduler's caller, for its schedules or for the agent's wake-ups, which is what their runs record as their
 * source. A busy session is refused, so the scheduler applies its own rule to it, as it did before v1: a cron
 * occurrence is skipped, a one-shot wake-up deferred to the next poll.
 */
export function scheduleCaller(agent: ProtocolAgent, kind: "schedule" | "wake"): LegacyAgent {
  return legacyAgent(agent, { kind }, "reject");
}

export function legacyAgent(
  agent: ProtocolAgent,
  source?: InvokeRequest["source"],
  whenBusy: "queue" | "reject" = "queue",
): LegacyAgent {
  return {
    invoke: (scope, prompt) =>
      cancellableStream(async function* ({ onCancelReady, wasCancelled }) {
        const label = `[${source?.name ?? source?.kind ?? "agent"}]`;
        try {
          if (scope.parentSession !== undefined) {
            await forkThread(agent, scope.session, scope.parentSession, scope.branchHints ?? [], label);
          }
        } catch (error) {
          yield { type: "failed", details: String(error), retryable: true };
          return;
        }
        if (wasCancelled()) return;
        const iterator = agent
          .invoke({ sessionId: scope.session, prompt, whenBusy, ...(source ? { source } : {}) })
          [Symbol.asyncIterator]();
        let runId: string | undefined;
        let ended = false;
        // Before `accepted` there is no run to cancel, and closing the stream would not withdraw the invoke: the run
        // would be accepted with nobody left to cancel it. So the stream stays open until `accepted` names the run.
        onCancelReady(() => {
          if (runId === undefined) return;
          if (!ended) void agent.sessions.get(scope.session).runs.cancel(runId);
          void iterator.return?.();
        });
        let lastError: string | undefined;
        const textOf = runText(() => runId);
        let terminal: AgentEvent | undefined;
        // The v1 stream holds a listener on the session until it is closed: closed on every way out, and before the
        // terminal is handed on, so a caller that stops at the terminal leaves nothing behind.
        try {
          events: for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
            const event: InvokeEvent = next.value;
            switch (event.type) {
              case "accepted":
                runId = event.run.runId;
                if (wasCancelled()) {
                  const canceled = await agent.sessions.get(scope.session).runs.cancel(runId);
                  if (!canceled.ok) log.warn(`${label} run ${runId} outlived its caller: ${canceled.error.message}`);
                  return;
                }
                break;
              case "rejected":
                terminal = failedFrom(event.error);
                break events;
              case "message_delta":
                if (event.channel === "thinking") yield { type: "thinking", delta: event.delta };
                else yield { type: "text", delta: textOf(event) };
                break;
              case "tool_started":
                yield { type: "tool_started", id: event.toolCallId, name: event.name, args: event.args };
                break;
              case "tool_progress":
                yield { type: "tool_progress", id: event.toolCallId, text: event.text };
                break;
              case "retry_scheduled":
                yield {
                  type: "retrying",
                  attempt: event.attempt,
                  maxAttempts: event.maxAttempts,
                  delayMs: event.delayMs,
                  reason: event.reason,
                };
                break;
              case "serving_error":
                lastError = event.message;
                break;
              case "entry": {
                const { entry } = event;
                if (entry.runId !== runId) break;
                const missing = textOf(event);
                if (missing !== "") yield { type: "text", delta: missing };
                if (entry.kind === "tool_result") {
                  const data = entry.data as { toolCallId: string; isError?: boolean; text?: string };
                  yield {
                    type: "tool_ended",
                    id: data.toolCallId,
                    isError: data.isError === true,
                    content: data.text ?? "",
                  };
                }
                if (entry.kind === "run_ended") {
                  ended = true;
                  terminal = terminalOf((entry.data as { outcome: RunOutcome }).outcome);
                  break events;
                }
                break;
              }
            }
          }
        } finally {
          await iterator.return?.();
        }
        yield terminal ?? {
          type: "failed",
          details: lastError ?? "the stream ended before its run did",
          retryable: true,
        };
      }),
  };
}
