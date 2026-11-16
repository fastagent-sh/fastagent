/**
 * One message's events, scripted: what an Agent answers, without an Agent. A message is the message as recorded, the
 * live text and the agent's settled answer when it says something, and its `done`; a refusal is the one `rejected`.
 * The message's own `user` entry is the Agent's to write (scripted-agent.ts).
 */
import {
  type AgentErrorData,
  type ErrorCode,
  type Message,
  type MessageStreamEvent,
  type SendRequest,
  agentError,
  errorData,
} from "../../packages/client/src/agent-api.ts";

/** One event a send streams, or the refusal of the send. */
export type TurnEvent = { type: "rejected"; error: AgentErrorData } | MessageStreamEvent;

/** How a scripted message ends. */
type Ending = { status: "completed" | "incomplete" | "canceled" } | { status: "failed"; error: AgentErrorData };

export type RunScript = { ending?: Ending; text?: string } | { rejected: AgentErrorData };

let messages = 0;

export const refused = (code: ErrorCode, message: string = code): RunScript => ({
  rejected: errorData(agentError(code, message)),
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
