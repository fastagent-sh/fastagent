/**
 * One message's events, scripted: what an Agent answers, without an Agent. A message is the message as recorded, the
 * live text and the agent's settled answer when it says something, and its `done`; a refusal is the one `rejected`.
 * The message's own `user` entry is the Agent's to write (scripted-agent.ts).
 */
import {
  type AgentErrorData,
  type ErrorCode,
  type Message,
  type SendRequest,
  agentError,
  errorData,
} from "../src/agent-api.ts";
import type { TurnEvent } from "../src/channels/kit/invoke-turn-kit.ts";

/** How a scripted message ends. */
export type Ending = { status: "completed" | "incomplete" | "canceled" } | { status: "failed"; error: AgentErrorData };

export type RunScript = { ending?: Ending; text?: string } | { rejected: AgentErrorData };

let messages = 0;

export const refused = (code: ErrorCode, message: string = code): RunScript => ({
  rejected: errorData(agentError(code, message)),
});

export const failed = (message: string, code: ErrorCode = "model_error"): RunScript => ({
  ending: { status: "failed", error: errorData(agentError(code, message)) },
});

const done = (id: string, ending: Ending, answer?: { entryId: string; text: string }): TurnEvent => ({
  type: "done",
  message: { id, sessionId: "s", ...ending, ...(answer ? { answer } : {}) } satisfies Message,
});

export function scriptedRun(request: SendRequest, script: RunScript = {}): TurnEvent[] {
  if ("rejected" in script) return [{ type: "rejected", error: script.rejected }];
  const id = `message-${++messages}`;
  const answer =
    script.text === undefined
      ? undefined
      : ({
          type: "entry",
          entry: { id: `${id}-answer`, timestamp: Date.now(), kind: "assistant", data: { text: script.text } },
        } satisfies TurnEvent);
  return [
    { type: "message", message: { id, sessionId: request.sessionId, status: "queued" } },
    ...(answer === undefined || script.text === undefined
      ? []
      : [{ type: "delta", channel: "text", text: script.text } satisfies TurnEvent, answer]),
    done(
      id,
      script.ending ?? { status: "completed" },
      answer && script.text !== undefined ? { entryId: answer.entry.id, text: script.text } : undefined,
    ),
  ];
}

/** The message the event builders below belong to, unless told otherwise. */
const MESSAGE = "message";
let built = 0;
const entryOf = (kind: string, data: Record<string, unknown>): TurnEvent => ({
  type: "entry",
  entry: { id: `e${++built}`, timestamp: 0, kind, data: data as never },
});

/** One event at a time, for a test that scripts a stream by hand. */
export const ev = {
  message: (id = MESSAGE, sessionId = "s"): TurnEvent => ({
    type: "message",
    message: { id, sessionId, status: "queued" },
  }),
  text: (text: string): TurnEvent => ({ type: "delta", channel: "text", text }),
  thinking: (text: string): TurnEvent => ({ type: "delta", channel: "thinking", text }),
  /** The settled reply the deltas add up to. */
  answer: (text: string): TurnEvent => entryOf("assistant", { text }),
  toolStarted: (toolCallId: string, name: string, args: Record<string, unknown> = {}): TurnEvent => ({
    type: "tool_started",
    toolCallId,
    name,
    args: args as never,
  }),
  toolProgress: (toolCallId: string, text: string): TurnEvent => ({ type: "tool_progress", toolCallId, text }),
  toolResult: (toolCallId: string, isError = false): TurnEvent =>
    entryOf("tool_result", { toolCallId, isError, text: "" }),
  retrying: (): TurnEvent => ({ type: "retrying", attempt: 1, maxAttempts: 4, delayMs: 1000, reason: "503" }),
  ended: (ending: Ending = { status: "completed" }, id = MESSAGE): TurnEvent => done(id, ending),
  failed: (message: string, options: { retryable?: boolean; code?: ErrorCode } = {}, id = MESSAGE): TurnEvent =>
    done(id, {
      status: "failed",
      error: {
        ...errorData(agentError(options.code ?? "model_error", message)),
        retryable: options.retryable ?? false,
      },
    }),
  rejected: (code: ErrorCode, message: string = code): TurnEvent => ({
    type: "rejected",
    error: errorData(agentError(code, message)),
  }),
};
