/**
 * Render an Agent event stream to two sinks plus an exit code — the `fastagent invoke` contract, a
 * PURE function (IO injected) so it is unit-testable: text deltas → `out`; tool start + an ERRORED
 * tool_ended → `err`; `failed` → `err` + a non-zero exit code (the CI-gating guarantee).
 *
 * An errored tool inside an otherwise-completed turn still surfaces (the diagnostic the operator
 * needs); tool_ended carries no name, so it is remembered from the matching tool_started.
 */
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
