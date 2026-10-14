/**
 * TEMPORARY, removed once the built-in channels and the scheduler speak SPEC v1 themselves (step 4, PR 4b): the v0.1
 * `Agent` they were written against, over the v1 `Agent` the serve now runs. Every write goes through the v1 Agent,
 * so a session keeps one writer. It keeps v0.1's own rules: a caller that stops reading cancels the run (v0.1 MUST 3),
 * and a busy session queues the message, so the only `session_busy` left is a full queue.
 */
import {
  ABORTED_CODE,
  type AgentEvent,
  type Agent as LegacyAgent,
  MISSING_MODEL_CODE,
  SESSION_BUSY_CODE,
} from "./agent.ts";
import { forkThread } from "./channels/kit/thread-fork.ts";
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

export function legacyAgent(agent: ProtocolAgent, source?: InvokeRequest["source"]): LegacyAgent {
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
          .invoke({ sessionId: scope.session, prompt, whenBusy: "queue", ...(source ? { source } : {}) })
          [Symbol.asyncIterator]();
        let runId: string | undefined;
        let ended = false;
        onCancelReady(() => {
          if (runId !== undefined && !ended) void agent.sessions.get(scope.session).runs.cancel(runId);
          void iterator.return?.();
        });
        let lastError: string | undefined;
        const textOf = runText(() => runId);
        for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
          const event: InvokeEvent = next.value;
          switch (event.type) {
            case "accepted":
              runId = event.run.runId;
              // Cancelled while the invoke was being accepted: the door had no run to stop yet.
              if (wasCancelled()) void agent.sessions.get(scope.session).runs.cancel(runId);
              break;
            case "rejected":
              yield failedFrom(event.error);
              return;
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
                yield terminalOf((entry.data as { outcome: RunOutcome }).outcome);
                return;
              }
              break;
            }
          }
        }
        yield { type: "failed", details: lastError ?? "the stream ended before its run did", retryable: true };
      }),
  };
}
