/** Render an Agent event stream to two sinks plus an exit code. */
import type { AgentEvent } from "../agent.ts";

export async function runInvokeStream(
  events: AsyncIterable<AgentEvent>,
  out: (text: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const toolName = new Map<string, string>(); // tool_ended carries no name — remember it from tool_started
  let exitCode = 0;
  for await (const event of events) {
    switch (event.type) {
      case "text":
        out(event.delta);
        break;
      case "tool_started":
        toolName.set(event.id, event.name);
        err(`[tool] ${event.name}`);
        break;
      case "tool_progress":
        err(`[tool] ${toolName.get(event.id) ?? event.id} › ${clipStatus(event.text)}`);
        break;
      case "tool_ended":
        if (event.isError) err(`[tool] ${toolName.get(event.id) ?? event.id} failed`);
        break;
      case "retrying":
        // Operator-facing: include the reason (channels show a neutral customer line instead).
        err(
          `[fastagent] transient failure — retrying (${event.attempt}/${event.maxAttempts} in ${event.delayMs}ms): ${event.reason}`,
        );
        break;
      case "failed":
        err(`[fastagent] failed: ${event.details}${event.retryable ? " (retryable)" : ""}`);
        exitCode = 1;
        break;
      case "completed":
        break; // terminal success — nothing to render (structured data, if any, is not a CLI concern)
    }
  }
  return exitCode;
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
