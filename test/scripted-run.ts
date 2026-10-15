/**
 * One invoke's events, scripted: what an Agent answers, without an Agent. A run is its receipt, the live text and its
 * settled message when it says something, and its `run_ended`; a refusal is the one `rejected` event.
 */
import {
  type AgentError,
  type ErrorCode,
  type InvokeEvent,
  type InvokeRequest,
  type RunOutcome,
  agentError,
} from "../src/protocol.ts";

export type RunScript = { outcome?: RunOutcome; text?: string } | { rejected: AgentError };

let runs = 0;

export const refused = (code: ErrorCode, message: string = code): RunScript => ({
  rejected: agentError(code, message),
});

export const failed = (message: string, code: ErrorCode = "model_error"): RunScript => ({
  outcome: { status: "failed", error: agentError(code, message) },
});

export function scriptedRun(request: InvokeRequest, script: RunScript = {}): InvokeEvent[] {
  if ("rejected" in script) return [{ type: "rejected", error: script.rejected }];
  const runId = `run-${++runs}`;
  const sessionId = request.sessionId ?? `session-${runId}`;
  let entries = 0;
  const entry = (kind: string, data: Record<string, unknown>): InvokeEvent => ({
    type: "entry",
    entry: { id: `${runId}-${++entries}`, timestamp: Date.now(), runId, kind, data: data as never },
  });
  return [
    {
      type: "accepted",
      sessionId,
      run: { runId, messages: [{}], status: "running", startedAt: Date.now() },
      joined: false,
      duplicate: false,
    },
    entry("user_message", { text: request.prompt.text }),
    ...(script.text === undefined
      ? []
      : [
          { type: "message_delta", runId, channel: "text", delta: script.text } satisfies InvokeEvent,
          entry("assistant_message", { text: script.text }),
        ]),
    entry("run_ended", { runId, outcome: script.outcome ?? { status: "completed" } }),
  ];
}
