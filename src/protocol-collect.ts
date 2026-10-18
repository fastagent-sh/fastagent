/**
 * The buffered consumer of an invoke stream (SPEC v1 §10): the message's answer, or a throw that says why there is none.
 */
import { AgentRejection, type InvokeEvent, type Outcome } from "./protocol.ts";

export interface CollectedMessage {
  sessionId: string;
  messageId: string;
  /** The message's answer; empty when its work wrote none. */
  text: string;
}

/** A message that ended, but not `completed`: its outcome says how. */
export class MessageNotCompleted extends Error {
  readonly outcome: Exclude<Outcome, { status: "completed" }>;
  readonly sessionId: string;
  readonly messageId: string;
  constructor(outcome: Exclude<Outcome, { status: "completed" }>, at: { sessionId: string; messageId: string }) {
    super(outcome.status === "failed" ? outcome.error.message : `the message ended ${outcome.status}`);
    this.name = "MessageNotCompleted";
    this.outcome = outcome;
    this.sessionId = at.sessionId;
    this.messageId = at.messageId;
  }
}

/** A stream that stopped before its message ended: the process went away, or the connection to it did. */
export class MessageUnfinished extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessageUnfinished";
  }
}

export async function collect(events: AsyncIterable<InvokeEvent>): Promise<CollectedMessage> {
  let receipt: { sessionId: string; messageId: string } | undefined;
  let lastError: string | undefined;
  for await (const event of events) {
    if (event.type === "rejected") throw new AgentRejection(event.error);
    if (event.type === "accepted") receipt = { sessionId: event.sessionId, messageId: event.message.messageId };
    if (event.type === "serving_error") lastError = event.message;
    if (event.type !== "done" || receipt === undefined || event.message.messageId !== receipt.messageId) continue;
    const { outcome, answer } = event.message;
    if (outcome.status !== "completed") throw new MessageNotCompleted(outcome, receipt);
    return { ...receipt, text: answer?.text ?? "" };
  }
  throw new MessageUnfinished(lastError ?? "the stream ended before its message did");
}
