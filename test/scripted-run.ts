/**
 * One message's events, scripted: what an Agent answers, without an Agent. A message is its receipt, the live text and
 * the agent's settled answer when it says something, and its `done`; a refusal is the one `rejected`. The message's own
 * `user_message` entry is the Agent's to write (scripted-agent.ts), since `stream` reads only what follows it.
 */
import {
  type AgentError,
  type DoneMessage,
  type ErrorCode,
  type InvokeRequest,
  type Outcome,
  agentError,
} from "../src/agent-api.ts";
import type { TurnEvent } from "../src/channels/kit/invoke-turn-kit.ts";

export type RunScript = { outcome?: Outcome; text?: string } | { rejected: AgentError };

let messages = 0;

export const refused = (code: ErrorCode, message: string = code): RunScript => ({
  rejected: agentError(code, message),
});

export const failed = (message: string, code: ErrorCode = "model_error"): RunScript => ({
  outcome: { status: "failed", error: agentError(code, message) },
});

const done = (messageId: string, outcome: Outcome, answer?: { entryId: string; text: string }): TurnEvent => ({
  type: "done",
  message: { messageId, status: "done", outcome, ...(answer ? { answer } : {}) } satisfies DoneMessage,
});

export function scriptedRun(request: InvokeRequest, script: RunScript = {}): TurnEvent[] {
  if ("rejected" in script) return [{ type: "rejected", error: script.rejected }];
  const messageId = `message-${++messages}`;
  const sessionId = request.sessionId ?? `session-${messageId}`;
  const answer =
    script.text === undefined
      ? undefined
      : ({
          type: "entry",
          entry: {
            id: `${messageId}-answer`,
            sessionId,
            timestamp: Date.now(),
            kind: "assistant_message",
            data: { text: script.text },
          },
        } satisfies TurnEvent);
  return [
    { type: "accepted", sessionId, message: { messageId, status: "queued", position: 0 }, duplicate: false },
    ...(answer === undefined || script.text === undefined
      ? []
      : [{ type: "message_delta", channel: "text", delta: script.text } satisfies TurnEvent, answer]),
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
const entryOf = (kind: string, data: Record<string, unknown>): TurnEvent => ({
  type: "entry",
  entry: { id: `e${++built}`, sessionId: "s", timestamp: 0, kind, data: data as never },
});

/** One event at a time, for a test that scripts a stream by hand. */
export const ev = {
  accepted: (messageId = MESSAGE, sessionId = "s"): TurnEvent => ({
    type: "accepted",
    sessionId,
    message: { messageId, status: "queued", position: 0 },
    duplicate: false,
  }),
  text: (delta: string): TurnEvent => ({ type: "message_delta", channel: "text", delta }),
  thinking: (delta: string): TurnEvent => ({ type: "message_delta", channel: "thinking", delta }),
  /** The settled message the deltas add up to. */
  answer: (text: string): TurnEvent => entryOf("assistant_message", { text }),
  toolStarted: (toolCallId: string, name: string, args: Record<string, unknown> = {}): TurnEvent => ({
    type: "tool_started",
    toolCallId,
    name,
    args: args as never,
  }),
  toolProgress: (toolCallId: string, text: string): TurnEvent => ({ type: "tool_progress", toolCallId, text }),
  toolResult: (toolCallId: string, isError = false): TurnEvent =>
    entryOf("tool_result", { toolCallId, isError, text: "" }),
  retrying: (): TurnEvent => ({ type: "retry_scheduled", attempt: 1, maxAttempts: 4, delayMs: 1000, reason: "503" }),
  ended: (outcome: Outcome = { status: "completed" }, messageId = MESSAGE): TurnEvent => done(messageId, outcome),
  failed: (message: string, options: { retryable?: boolean; code?: ErrorCode } = {}, messageId = MESSAGE): TurnEvent =>
    done(messageId, {
      status: "failed",
      error: { ...agentError(options.code ?? "model_error", message), retryable: options.retryable ?? false },
    }),
  rejected: (code: ErrorCode, message: string = code): TurnEvent => ({
    type: "rejected",
    error: agentError(code, message),
  }),
  unknown: (reason = "the storage did not answer"): TurnEvent => ({ type: "unknown", reason }),
};
