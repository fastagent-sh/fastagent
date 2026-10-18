/**
 * One invoke's events, scripted: what an Agent answers, without an Agent. A message is its receipt, its own entry, the
 * live text and the agent's settled message when it says something, and its `done`; a refusal is the one `rejected`.
 */
import {
  type AgentError,
  type DoneMessage,
  type ErrorCode,
  type InvokeEvent,
  type InvokeRequest,
  type Outcome,
  agentError,
} from "../src/protocol.ts";

export type RunScript = { outcome?: Outcome; text?: string } | { rejected: AgentError };

let messages = 0;

export const refused = (code: ErrorCode, message: string = code): RunScript => ({
  rejected: agentError(code, message),
});

export const failed = (message: string, code: ErrorCode = "model_error"): RunScript => ({
  outcome: { status: "failed", error: agentError(code, message) },
});

const done = (messageId: string, outcome: Outcome, answer?: { entryId: string; text: string }): InvokeEvent => ({
  type: "done",
  message: { messageId, status: "done", endedAt: Date.now(), outcome, ...(answer ? { answer } : {}) } as DoneMessage,
});

export function scriptedRun(request: InvokeRequest, script: RunScript = {}): InvokeEvent[] {
  if ("rejected" in script) return [{ type: "rejected", error: script.rejected }];
  const messageId = `message-${++messages}`;
  const sessionId = request.sessionId ?? `session-${messageId}`;
  let entries = 0;
  const entry = (kind: string, data: Record<string, unknown>): Extract<InvokeEvent, { type: "entry" }> => ({
    type: "entry",
    entry: { id: `${messageId}-${++entries}`, timestamp: Date.now(), kind, data: data as never },
  });
  const answer = script.text === undefined ? undefined : entry("assistant_message", { text: script.text });
  return [
    { type: "accepted", sessionId, message: { messageId, status: "queued", position: 0 }, duplicate: false },
    entry("user_message", { text: request.prompt.text, messageId }),
    ...(script.text === undefined || answer === undefined
      ? []
      : [{ type: "message_delta", channel: "text", delta: script.text } satisfies InvokeEvent, answer]),
    done(
      messageId,
      script.outcome ?? { status: "completed" },
      answer && script.text !== undefined ? { entryId: answer.entry.id, text: script.text } : undefined,
    ),
  ];
}

/** The message the event builders below belong to, unless told otherwise. */
const MESSAGE = "message";
let built = 0;
const entryOf = (kind: string, data: Record<string, unknown>): InvokeEvent => ({
  type: "entry",
  entry: { id: `e${++built}`, timestamp: 0, kind, data: data as never },
});

/** One v1 event at a time, for a test that scripts a stream by hand. */
export const ev = {
  accepted: (messageId = MESSAGE, sessionId = "s"): InvokeEvent => ({
    type: "accepted",
    sessionId,
    message: { messageId, status: "queued", position: 0 },
    duplicate: false,
  }),
  text: (delta: string): InvokeEvent => ({ type: "message_delta", channel: "text", delta }),
  thinking: (delta: string): InvokeEvent => ({ type: "message_delta", channel: "thinking", delta }),
  /** The settled message the deltas add up to. */
  answer: (text: string): InvokeEvent => entryOf("assistant_message", { text }),
  toolStarted: (toolCallId: string, name: string, args: Record<string, unknown> = {}): InvokeEvent => ({
    type: "tool_started",
    toolCallId,
    name,
    args: args as never,
  }),
  toolProgress: (toolCallId: string, text: string): InvokeEvent => ({ type: "tool_progress", toolCallId, text }),
  toolResult: (toolCallId: string, isError = false): InvokeEvent =>
    entryOf("tool_result", { toolCallId, isError, text: "" }),
  retrying: (): InvokeEvent => ({ type: "retry_scheduled", attempt: 1, maxAttempts: 4, delayMs: 1000, reason: "503" }),
  ended: (outcome: Outcome = { status: "completed" }, messageId = MESSAGE): InvokeEvent => done(messageId, outcome),
  failed: (
    message: string,
    options: { retryable?: boolean; code?: ErrorCode } = {},
    messageId = MESSAGE,
  ): InvokeEvent =>
    done(messageId, {
      status: "failed",
      error: { ...agentError(options.code ?? "model_error", message), retryable: options.retryable ?? false },
    }),
  rejected: (code: ErrorCode, message: string = code): InvokeEvent => ({
    type: "rejected",
    error: agentError(code, message),
  }),
};
