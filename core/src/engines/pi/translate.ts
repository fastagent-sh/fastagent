/**
 * The single pi dependency point for event mapping: pi events/finals → SPEC AgentEvent.
 *   - toAgentEvent: in-stream events (text / tool_*); all other pi events return null (dropped).
 *   - toTerminal:   the AssistantMessage resolved by pi `prompt()` → completed / failed.
 *   - errorToTerminal: catch-all for genuine throws → failed.
 */
import type { AgentHarnessEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentEvent, Json } from "../../agent.ts";

/** In-stream event mapping. Non text/tool_* pi events (turn_start, message_start, …) are dropped. */
export function toAgentEvent(pe: AgentHarnessEvent): AgentEvent | null {
  switch (pe.type) {
    case "message_update":
      if (pe.assistantMessageEvent.type === "text_delta") {
        return { type: "text", delta: pe.assistantMessageEvent.delta };
      }
      return null;
    case "tool_execution_start":
      return {
        type: "tool_started",
        id: pe.toolCallId,
        name: pe.toolName,
        args: pe.args as Json,
      };
    case "tool_execution_end":
      return {
        type: "tool_ended",
        id: pe.toolCallId,
        isError: pe.isError,
        content: pe.result as Json,
      };
    default:
      return null;
  }
}

/**
 * Terminal mapping. **Decided by the resolved message's stopReason** (core-design §8):
 * pi's prompt() does not necessarily throw on model error/abort — the normal path is
 * resolving a message with stopReason "error" | "aborted". Relying on catch alone would
 * miss this entire failure class (violating MUST 1).
 */
export function toTerminal(message: AssistantMessage): AgentEvent {
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    const details = message.errorMessage ?? `model stopped: ${message.stopReason}`;
    return { type: "failed", details, retryable: isRetryable(details) };
  }
  return { type: "completed" };
}

/** Catch-all: genuinely thrown exceptions → failed. */
export function errorToTerminal(error: unknown): AgentEvent {
  const details = error instanceof Error ? error.message : String(error);
  return { type: "failed", details, retryable: isRetryable(details) };
}

/**
 * Minimal retryable heuristic (pi's _isRetryableError is not exported).
 * Matching a transient-looking error pattern means "worth re-sending".
 */
const RETRYABLE =
  /\b(429|5\d\d|timeout|timed out|rate.?limit|overloaded|ECONNRESET|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|socket hang up)\b/i;

function isRetryable(details: string): boolean {
  return RETRYABLE.test(details);
}
