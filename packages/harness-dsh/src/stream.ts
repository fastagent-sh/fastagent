/**
 * `messages.stream`: send a message and deliver it as it is written, over the Agent's own reads.
 * The session is watched before the message is sent, so nothing it writes afterwards is missed; a send whose key the
 * session has seen delivers that message from wherever it is.
 */
import {
  AgentError,
  type Entry,
  type Message,
  type MessageStreamEvent,
  type Page,
  type SendRequest,
  type SessionEvent,
  agentError,
  errorData,
  hasEnded,
} from "@fastagent-sh/client/agent-api";

export interface StreamSource {
  events(sessionId: string, after?: string): AsyncIterable<SessionEvent>;
  admit(request: SendRequest): Promise<{ message: Message; replayed: boolean }>;
  get(sessionId: string, messageId: string): Promise<Message>;
  entry(sessionId: string, entryId: string): Promise<Entry>;
  entries(sessionId: string, options: { after: string }): Promise<Page<Entry>>;
}

const messageOf = (entry: Entry): string | undefined =>
  entry.kind === "user" ? (entry.data as { messageId?: string }).messageId : undefined;

const failedRead = (error: unknown): SessionEvent => ({
  type: "stream_error",
  error: errorData(
    error instanceof AgentError
      ? error
      : agentError("internal", error instanceof Error ? error.message : String(error)),
  ),
});

const nextOf = (events: AsyncIterator<SessionEvent>): Promise<IteratorResult<SessionEvent>> =>
  events.next().catch((error: unknown) => ({ done: false, value: failedRead(error) }));

export function messageStream(
  source: StreamSource,
  request: SendRequest,
  signal: AbortSignal | undefined,
): AsyncIterable<MessageStreamEvent> {
  const { sessionId } = request;
  let active: AsyncIterator<SessionEvent> | undefined;
  const leave = () => {
    const current = active;
    active = undefined;
    void current?.return?.();
  };
  const follow = (after?: string) => {
    leave();
    active = source.events(sessionId, after)[Symbol.asyncIterator]();
    return active;
  };

  async function* live(watching: AsyncIterator<SessionEvent>, id: string): AsyncGenerator<SessionEvent> {
    let opened = false;
    for (let next = await watching.next(); !next.done; next = await watching.next()) {
      const event = next.value;
      if (event.type === "stream_error") return yield event;
      if (event.type === "done" && event.message.id === id) return yield event;
      if (!opened && event.type === "entry" && messageOf(event.entry) === id) opened = true;
      if (opened) yield event;
    }
  }

  async function* running(message: Message & { entryId: string }): AsyncGenerator<SessionEvent> {
    let opening: Entry;
    try {
      opening = await source.entry(sessionId, message.entryId);
    } catch (error) {
      return yield failedRead(error);
    }
    const after = follow(message.entryId);
    const held: SessionEvent[] = [];
    for (let next = await nextOf(after); !next.done; next = await nextOf(after)) {
      const event = next.value;
      if (event.type === "stream_error") return yield event;
      if (event.type !== "state") {
        held.push(event);
        continue;
      }
      let now: Message;
      try {
        now = await source.get(sessionId, message.id);
      } catch (error) {
        return yield failedRead(error);
      }
      if (hasEnded(now)) {
        leave();
        return yield* ended(now, opening, held);
      }
      yield { type: "entry", entry: opening };
      yield* held;
      yield event;
      for (let next = await nextOf(after); !next.done; next = await nextOf(after)) {
        const event = next.value;
        yield event;
        if (event.type === "stream_error") return;
        if (event.type === "done" && event.message.id === message.id) return;
      }
      return;
    }
  }

  async function* ended(done: Message, opening?: Entry, held?: SessionEvent[]): AsyncGenerator<SessionEvent> {
    const { entryId, answer } = done;
    if (entryId === undefined) return yield { type: "done", message: done };
    try {
      yield { type: "entry", entry: opening ?? (await source.entry(sessionId, entryId)) };
    } catch (error) {
      return yield failedRead(error);
    }
    if (answer === undefined) return yield { type: "done", message: done };
    const through = held?.findIndex((event) => event.type === "entry" && event.entry.id === answer.entryId) ?? -1;
    if (held !== undefined && through !== -1) {
      yield* held.slice(0, through + 1).filter((event) => event.type === "entry");
      return yield { type: "done", message: done };
    }
    let cursor = entryId;
    for (;;) {
      let page: Page<Entry>;
      try {
        page = await source.entries(sessionId, { after: cursor });
      } catch (error) {
        return yield failedRead(error);
      }
      for (const entry of page.data) {
        yield { type: "entry", entry };
        if (entry.id === answer.entryId) return yield { type: "done", message: done };
      }
      if (page.next === undefined) {
        return yield failedRead(
          agentError("internal", `the answer ${answer.entryId} of message ${done.id} is not in its session`),
        );
      }
      cursor = page.next;
    }
  }

  async function* events(): AsyncGenerator<MessageStreamEvent> {
    try {
      const watching = follow();
      const snapshot = await watching.next();
      if (snapshot.done || snapshot.value.type !== "state") {
        if (!snapshot.done && snapshot.value.type === "stream_error") throw new AgentError(snapshot.value.error);
        throw agentError("internal", "the session's events did not begin with its state");
      }
      const { message, replayed } = await source.admit(request);
      yield { type: "message", message };
      if (hasEnded(message)) {
        leave();
        yield* ended(message);
      } else if (replayed && message.status === "running" && message.entryId !== undefined) {
        yield* running({ ...message, entryId: message.entryId });
      } else yield* live(watching, message.id);
    } finally {
      leave();
    }
  }

  return { [Symbol.asyncIterator]: () => leavableIterator(events(), leave, signal) };
}

export function leavableIterator<T>(
  gen: AsyncGenerator<T>,
  leave: () => void,
  signal: AbortSignal | undefined,
): AsyncIterator<T> {
  let left = false;
  const teardown = async () => {
    left = true;
    leave();
    await gen.return(undefined as never).catch(() => {});
  };
  const released = (): never => {
    throw signal?.reason;
  };
  let onAbort: (() => void) | undefined;
  const aborted =
    signal === undefined
      ? undefined
      : new Promise<never>((_, reject) => {
          onAbort = () => {
            void teardown();
            reject(signal.reason);
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        });
  aborted?.catch(() => {});
  const stopListening = () => {
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  };
  return {
    async next() {
      if (signal?.aborted) released();
      const result = await (aborted === undefined ? gen.next() : Promise.race([gen.next(), aborted]));
      if (left) {
        if (signal?.aborted) released();
        return { done: true as const, value: undefined };
      }
      if (result.done) stopListening();
      return result;
    },
    async return() {
      stopListening();
      await teardown();
      return { done: true as const, value: undefined };
    },
    async throw(error?: unknown): Promise<IteratorResult<T>> {
      stopListening();
      await teardown();
      throw error;
    },
  };
}
