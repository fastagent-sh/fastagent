/**
 * `stream(agent, request)` (docs/design/agent-api.md §10): send a message and read its answer as it is written. A Caller
 * of the Agent API, over any `Agent`, in process or remote, adding nothing to it. Imports no harness.
 */
import {
  type Agent,
  AgentRejection,
  type DoneMessage,
  type Entry,
  type InvokeRequest,
  type InvokeResult,
  type Receipt,
  type ResumeEvent,
  type SessionEvent,
  agentError,
} from "./agent-api.ts";
import { abortFirstIterator } from "./sse-client.ts";

export type StreamResult =
  | ({ ok: true } & Receipt & { events: AsyncIterable<SessionEvent> })
  | Extract<InvokeResult, { ok: false }>;

const userMessageOf = (entry: Entry): string | undefined =>
  entry.kind === "user_message" ? (entry.data as { messageId?: string }).messageId : undefined;

/** A `rejected` cannot follow a snapshot; one that does is the end of the stream, said as such. */
const asSessionEvent = (event: ResumeEvent): SessionEvent =>
  event.type === "rejected" ? { type: "serving_error", error: event.error } : event;

const failedRead = (error: unknown): SessionEvent => ({
  type: "serving_error",
  error:
    error instanceof AgentRejection
      ? { code: error.code, message: error.message, retryable: error.retryable }
      : agentError("internal", error instanceof Error ? error.message : String(error)),
});

/**
 * The session must exist, so it can be resumed before the message is sent: nothing it writes after that is missed. A
 * new conversation creates its session first, which also keeps a key's retry in one session (§3.3).
 */
export async function stream(agent: Agent, request: InvokeRequest & { sessionId: string }): Promise<StreamResult> {
  const { sessionId } = request;
  const watching = agent.resume(sessionId)[Symbol.asyncIterator]();
  const snapshot = await watching.next();
  if (snapshot.done || snapshot.value.type !== "state") {
    await watching.return?.();
    const error = snapshot.done
      ? agentError("unavailable", "the session's events ended before its snapshot")
      : snapshot.value.type === "rejected" || snapshot.value.type === "serving_error"
        ? snapshot.value.error
        : agentError("internal", `a resume began with ${snapshot.value.type}, not its snapshot`);
    return { ok: false, error };
  }
  const result = await agent.invoke(request);
  if (!result.ok) {
    await watching.return?.();
    return result;
  }
  const { ok: _, wait: _wait, ...receipt } = result;
  const { message } = receipt;
  let active: AsyncIterator<ResumeEvent> | undefined = watching;
  const leave = () => {
    const current = active;
    active = undefined;
    void current?.return?.();
  };

  /** A new or queued message: what follows its `user_message`, which arrives live, through its `done`. */
  async function* live(): AsyncGenerator<SessionEvent> {
    let opened = false;
    for (let next = await watching.next(); !next.done; next = await watching.next()) {
      const event = asSessionEvent(next.value);
      if (event.type === "serving_error") return yield event;
      // A queued message withdrawn by an abort ends without ever being taken.
      if (event.type === "done" && event.message.messageId === message.messageId) return yield event;
      if (opened) yield event;
      else if (event.type === "entry" && userMessageOf(event.entry) === message.messageId) opened = true;
    }
  }

  /**
   * A taken duplicate, whose `user_message` was written before: resumed after it. What that replays is held until the
   * message's status is known, since a message that ended meanwhile may have been followed by the next one's entries.
   */
  async function* taken(entryId: string): AsyncGenerator<SessionEvent> {
    await watching.return?.();
    const after = agent.resume(sessionId, { replayFrom: { type: "after", entryId } })[Symbol.asyncIterator]();
    active = after;
    const held: SessionEvent[] = [];
    for (let next = await after.next(); !next.done; next = await after.next()) {
      const event = asSessionEvent(next.value);
      if (event.type === "serving_error") return yield event;
      if (event.type !== "state") {
        held.push(event);
        continue;
      }
      let now: Awaited<ReturnType<Agent["getMessage"]>>;
      try {
        now = await agent.getMessage(sessionId, { messageId: message.messageId });
      } catch (error) {
        return yield failedRead(error);
      }
      if (now?.status === "done") return yield* ended(now, held);
      yield* held;
      yield event;
      for (let live = await after.next(); !live.done; live = await after.next()) {
        const event = asSessionEvent(live.value);
        yield event;
        if (event.type === "serving_error") return;
        if (event.type === "done" && event.message.messageId === message.messageId) return;
      }
      return;
    }
  }

  /** A message already done: the entries after its `user_message` through its answer, or none, then its `done`. */
  async function* ended(done: DoneMessage, held?: SessionEvent[]): AsyncGenerator<SessionEvent> {
    const answer = done.answer?.entryId;
    if (answer !== undefined && done.entryId !== undefined) {
      if (held !== undefined) {
        const through = held.findIndex((event) => event.type === "entry" && event.entry.id === answer);
        if (through !== -1) {
          yield* held.slice(0, through + 1).filter((event) => event.type === "entry");
          return yield { type: "done", message: done };
        }
      }
      let cursor = done.entryId;
      for (;;) {
        const page = await agent.read(sessionId, { after: cursor, limit: 500 });
        if (!page.ok) return yield { type: "serving_error", error: page.error };
        for (const entry of page.entries) {
          yield { type: "entry", entry };
          if (entry.id === answer) return yield { type: "done", message: done };
        }
        if (page.next === undefined) {
          return yield {
            type: "serving_error",
            error: agentError("internal", `the answer ${answer} of message ${done.messageId} is not in its session`),
          };
        }
        cursor = page.next;
      }
    }
    yield { type: "done", message: done };
  }

  async function* events(): AsyncGenerator<SessionEvent> {
    try {
      if (message.status === "done") {
        leave();
        yield* ended(message);
      } else if (message.status === "taken" && receipt.duplicate) yield* taken(message.entryId);
      else yield* live();
    } finally {
      leave();
    }
  }
  const iterator = abortFirstIterator(events(), leave);
  return { ok: true, ...receipt, events: { [Symbol.asyncIterator]: () => iterator } };
}
