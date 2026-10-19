/** Render an invoke stream to two sinks plus an exit code: 0 only for a message that ended `completed`. */
import { answerText } from "../answer-text.ts";
import type { InvokeEvent, Outcome } from "../protocol.ts";

function failure(outcome: Outcome): string | undefined {
  switch (outcome.status) {
    case "completed":
      return undefined;
    case "failed":
      return `${outcome.error.code}: ${outcome.error.message}${outcome.error.retryable ? " (retryable)" : ""}`;
    default:
      return outcome.status;
  }
}

export async function runInvokeStream(
  events: AsyncIterable<InvokeEvent>,
  out: (text: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const toolName = new Map<string, string>(); // a tool result carries the id; its name came with tool_started
  let messageId: string | undefined;
  const textOf = answerText();
  for await (const event of events) {
    const text = event.type === "message_delta" || event.type === "entry" ? textOf(event) : "";
    if (text !== "") out(text);
    switch (event.type) {
      case "accepted":
        messageId = event.message.messageId;
        break;
      case "rejected":
        err(`[fastagent] rejected: ${event.error.code}: ${event.error.message}`);
        return 1;
      case "tool_started":
        toolName.set(event.toolCallId, event.name);
        err(`[tool] ${event.name}`);
        break;
      case "tool_progress":
        err(`[tool] ${toolName.get(event.toolCallId) ?? event.toolCallId} › ${clipStatus(event.text)}`);
        break;
      case "retry_scheduled":
        // Operator-facing: include the reason (channels show a neutral customer line instead).
        err(
          `[fastagent] transient failure — retrying (${event.attempt}/${event.maxAttempts} in ${event.delayMs}ms): ${event.reason}`,
        );
        break;
      case "serving_error":
        err(`[fastagent] ${event.message}`);
        break;
      case "entry": {
        const data = event.entry.data as { toolCallId?: string; isError?: boolean };
        if (event.entry.kind === "tool_result" && data.isError) {
          err(`[tool] ${toolName.get(data.toolCallId ?? "") ?? data.toolCallId} failed`);
        }
        break;
      }
      case "done": {
        if (event.message.messageId !== messageId) break;
        const failed = failure(event.message.outcome);
        if (failed === undefined) return 0;
        err(`[fastagent] failed: ${failed}`);
        return 1;
      }
    }
  }
  err("[fastagent] the stream ended before the message did");
  return 1;
}

/** How much of a status line a terminal gets, in code points. */
const STATUS_MAX = 120;

/**
 * A `tool_progress` line clipped to {@link STATUS_MAX} code points. The event is untruncated by contract, and a shell
 * printing one long line (`curl -s` of a JSON body) re-sends that growing line every 100 ms.
 */
function clipStatus(text: string): string {
  // Only the first STATUS_MAX + 1 code points decide the result, and they fit in twice as many UTF-16 units.
  const head = [...text.slice(0, (STATUS_MAX + 1) * 2)];
  return head.length > STATUS_MAX ? `${head.slice(0, STATUS_MAX).join("")}…` : head.join("");
}
