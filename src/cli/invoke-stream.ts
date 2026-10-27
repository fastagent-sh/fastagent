/** Render one message's answer, as `stream()` reads it, plus an exit code: 0 only for `completed`. */
import type { Outcome } from "../agent-api.ts";
import type { StreamResult } from "../agent-api-stream.ts";
import { answerText } from "../answer-text.ts";

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

/** The answer as text on `out`, what the tools did and why it failed on `err`. */
export async function runInvokeStream(
  result: StreamResult,
  out: (text: string) => void,
  err: (line: string) => void,
): Promise<number> {
  if (!result.ok) {
    if ("error" in result) err(`[fastagent] rejected: ${result.error.code}: ${result.error.message}`);
    else err(`[fastagent] whether the message was taken is not known: ${result.unknown.reason}`);
    return 1;
  }
  const toolName = new Map<string, string>(); // a tool result carries the id; its name came with tool_started
  const textOf = answerText();
  for await (const event of result.events) {
    const text = event.type === "message_delta" || event.type === "entry" ? textOf(event) : "";
    if (text !== "") out(text);
    switch (event.type) {
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
        err(`[fastagent] ${event.error.message}`);
        return 1;
      case "entry": {
        const data = event.entry.data as { toolCallId?: string; isError?: boolean };
        if (event.entry.kind === "tool_result" && data.isError) {
          err(`[tool] ${toolName.get(data.toolCallId ?? "") ?? data.toolCallId} failed`);
        }
        break;
      }
      case "done": {
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

/**
 * The answer as JSON lines, for a program to read: the receipt (`{ "type": "receipt", sessionId, message, duplicate }`),
 * then the message's events as the Agent API has them, through its `done`. A message that ends no other way ends with
 * the line that says why: the invoke's `rejected` (as `resume` has it) or `unknown`, a `serving_error` event, or
 * `unfinished` when the events end first.
 */
export async function runInvokeJson(result: StreamResult, line: (json: string) => void): Promise<number> {
  if (!result.ok) {
    line(
      JSON.stringify(
        "error" in result ? { type: "rejected", error: result.error } : { type: "unknown", ...result.unknown },
      ),
    );
    return 1;
  }
  const { ok: _, events, ...receipt } = result;
  line(JSON.stringify({ type: "receipt", ...receipt }));
  for await (const event of events) {
    line(JSON.stringify(event));
    if (event.type === "serving_error") return 1;
    if (event.type === "done") return failure(event.message.outcome) === undefined ? 0 : 1;
  }
  line(JSON.stringify({ type: "unfinished", reason: "the stream ended before the message did" }));
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
