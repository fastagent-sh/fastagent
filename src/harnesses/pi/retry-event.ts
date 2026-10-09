import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { RetryScheduledEvent } from "../../session.ts";

/** Manual compaction retries are session-scoped; retries inside an invoke carry its runId. */
export function toRetryScheduledEvent(
  event: Extract<AgentSessionEvent, { type: "auto_retry_start" | "summarization_retry_scheduled" }>,
  runId?: string,
): RetryScheduledEvent {
  return {
    type: "retry_scheduled",
    timestamp: Date.now(),
    ...(runId === undefined ? {} : { runId }),
    data: {
      operation: event.type === "auto_retry_start" ? "assistant" : "compaction",
      attempt: event.attempt,
      maxAttempts: event.maxAttempts,
      delayMs: event.delayMs,
      error: event.errorMessage,
    },
  };
}
