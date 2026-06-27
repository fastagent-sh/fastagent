/**
 * Render an Agent event stream to two output sinks plus an exit code — the `fastagent invoke` contract,
 * pulled out of cli.ts as a PURE function (IO injected, no process/stream access) so the contract is
 * unit-testable rather than resting on a live-model smoke run:
 *
 *   - `text` deltas → `out` (the reply, streamed; stdout at the CLI),
 *   - `tool_started` and a `tool_ended` that ERRORED → `err` (diagnostics; stderr at the CLI),
 *   - `failed` → `err` (the reason) and a non-zero exit code (the CI-gating guarantee).
 *
 * A `tool_ended` with `isError: true` inside an otherwise-`completed` turn must still surface — a
 * failed tool that does not fail the turn is exactly the diagnostic the operator needs. Its event
 * carries no name, so the name is remembered from the matching `tool_started`. The trailing newline
 * that ends the streamed reply is the caller's concern (only it knows the output device).
 */
import type { AgentEvent } from "./agent.ts";

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
