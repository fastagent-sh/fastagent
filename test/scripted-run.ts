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

/** The run the event builders below belong to, unless told otherwise. */
const RUN = "run";
let built = 0;
const entryOf = (kind: string, data: Record<string, unknown>, runId: string): InvokeEvent => ({
  type: "entry",
  entry: { id: `${runId}-e${++built}`, timestamp: 0, runId, kind, data: data as never },
});

/** One v1 event at a time, for a test that scripts a stream by hand. */
export const ev = {
  accepted: (runId = RUN, sessionId = "s"): InvokeEvent => ({
    type: "accepted",
    sessionId,
    run: { runId, messages: [{}], status: "running", startedAt: 0 },
    joined: false,
    duplicate: false,
  }),
  text: (delta: string, runId = RUN): InvokeEvent => ({ type: "message_delta", runId, channel: "text", delta }),
  thinking: (delta: string, runId = RUN): InvokeEvent => ({ type: "message_delta", runId, channel: "thinking", delta }),
  /** The settled message the deltas add up to. */
  answer: (text: string, runId = RUN): InvokeEvent => entryOf("assistant_message", { text }, runId),
  toolStarted: (toolCallId: string, name: string, args: Record<string, unknown> = {}, runId = RUN): InvokeEvent => ({
    type: "tool_started",
    runId,
    toolCallId,
    name,
    args: args as never,
  }),
  toolProgress: (toolCallId: string, text: string, runId = RUN): InvokeEvent => ({
    type: "tool_progress",
    runId,
    toolCallId,
    text,
  }),
  toolResult: (toolCallId: string, isError = false, runId = RUN): InvokeEvent =>
    entryOf("tool_result", { toolCallId, isError, text: "" }, runId),
  retrying: (runId = RUN): InvokeEvent => ({
    type: "retry_scheduled",
    runId,
    attempt: 1,
    maxAttempts: 4,
    delayMs: 1000,
    reason: "503",
  }),
  ended: (outcome: RunOutcome = { status: "completed" }, runId = RUN): InvokeEvent =>
    entryOf("run_ended", { runId, outcome }, runId),
  failed: (message: string, options: { retryable?: boolean; code?: ErrorCode } = {}, runId = RUN): InvokeEvent =>
    entryOf(
      "run_ended",
      {
        runId,
        outcome: {
          status: "failed",
          error: { ...agentError(options.code ?? "model_error", message), retryable: options.retryable ?? false },
        },
      },
      runId,
    ),
  rejected: (code: ErrorCode, message: string = code): InvokeEvent => ({
    type: "rejected",
    error: agentError(code, message),
  }),
};
