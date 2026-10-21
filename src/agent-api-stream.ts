/** Message waiting and streaming as Callers of the Agent API: no harness imports, and observing never stops work. */
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import {
  type Agent,
  type AgentError,
  type DoneMessage,
  type Entry,
  type InvokeRequest,
  type InvokeResult,
  type Receipt,
  type ResumeEvent,
  type SessionEvent,
  type WaitResult,
  AgentRejection,
  agentError,
} from "./agent-api.ts";
import { port, portError } from "./effect-port.ts";
import { abortFirstIterator } from "./sse-client.ts";

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));
const failed = (error: unknown): SessionEvent => ({
  type: "serving_error",
  error: agentError("unavailable", reason(error)),
});

/** A live-only `done` may have come before attachment: query after the snapshot, then observe the later commits. */
export async function waitForMessage(
  agent: Agent,
  receipt: Receipt,
  options?: { signal?: AbortSignal },
): Promise<WaitResult> {
  if (receipt.message.status === "done") return { ok: true, message: receipt.message };
  const exit = await Effect.runPromiseExit(
    Effect.acquireUseRelease(
      Effect.sync(() => agent.resume(receipt.sessionId)[Symbol.asyncIterator]()),
      (iterator) =>
        port(async () => {
          for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
            const event = next.value;
            if (event.type === "done" && event.message.messageId === receipt.message.messageId) return event.message;
            if (event.type === "state") {
              const now = await agent.getMessage(receipt.sessionId, { messageId: receipt.message.messageId });
              if (now?.status === "done") return now;
              if (now === undefined) throw new Error("The recorded message could not be found");
            }
            if (event.type === "serving_error" || event.type === "rejected") throw new AgentRejection(event.error);
          }
          throw new Error("The session stream ended before the message did");
        }),
      (iterator) =>
        Effect.promise(async () => {
          await iterator.return?.();
        }),
    ),
    { signal: options?.signal },
  );
  return Exit.isSuccess(exit)
    ? { ok: true, message: exit.value }
    : {
        ok: false,
        unfinished: { reason: options?.signal?.aborted ? "The wait was aborted" : reason(portError(exit.cause)) },
      };
}

export type StreamResult =
  | ({ ok: true } & Receipt & { events: AsyncIterable<SessionEvent> })
  | Extract<InvokeResult, { ok: false }>;

/** Open observation first, then send once. A duplicate may need a bounded replay instead of the live user entry. */
export async function stream(agent: Agent, request: InvokeRequest & { sessionId: string }): Promise<StreamResult> {
  let iterator = agent.resume(request.sessionId)[Symbol.asyncIterator]();
  let held: Entry[] = [];
  let sent = false;
  let receipt: Receipt | undefined;
  try {
    const snapshot = await snapshotOf(iterator);
    if (snapshot !== undefined) {
      await iterator.return?.();
      return { ok: false, error: snapshot };
    }
    sent = true;
    const result = await agent.invoke(request);
    if (!result.ok) {
      await iterator.return?.();
      return result;
    }
    receipt = { sessionId: result.sessionId, message: result.message, duplicate: result.duplicate };
    let message = result.message;
    if (result.duplicate && message.status === "taken") {
      await iterator.return?.();
      iterator = agent
        .resume(result.sessionId, { replayFrom: { type: "after", entryId: message.entryId } })
        [Symbol.asyncIterator]();
      held = [];
      const error = await snapshotOf(iterator, held);
      if (error !== undefined) throw new AgentRejection(error);
      const current = await agent.getMessage(result.sessionId, { messageId: message.messageId });
      if (current === undefined) throw new Error("The duplicate message could not be found");
      message = current;
    }
    const abort = new AbortController();
    let closing: Promise<unknown> | undefined;
    const close = () => (closing ??= Promise.resolve().then(() => iterator.return?.()));
    const next = () =>
      Effect.runPromise(
        port(() => iterator.next()),
        { signal: abort.signal },
      );
    const events = (async function* (): AsyncGenerator<SessionEvent> {
      try {
        if (message.status === "done") {
          // Reading by the durable answer bound excludes entries a later message wrote before reattachment.
          if (message.answer !== undefined && message.entryId !== undefined) {
            yield* answerEntries(agent, result.sessionId, message, abort.signal);
          }
          yield { type: "done", message };
          return;
        }
        for (const entry of held) yield { type: "entry", entry };
        let taken = result.duplicate && message.status === "taken";
        for (let item = await next(); !item.done; item = await next()) {
          const event = item.value;
          if (event.type === "serving_error") {
            yield event;
            return;
          }
          if (event.type === "rejected") {
            yield { type: "serving_error", error: event.error };
            return;
          }
          if (event.type === "done" && event.message.messageId === message.messageId) {
            yield event;
            return;
          }
          if (
            event.type === "entry" &&
            event.entry.kind === "user_message" &&
            (event.entry.data as { messageId?: string }).messageId === message.messageId
          ) {
            taken = true;
            continue;
          }
          if (taken && event.type !== "done" && event.type !== "state") yield event;
        }
        yield failed("The session stream ended before the message did");
      } catch (error) {
        // Observation failure ends only this stream; a recorded message remains recoverable by id.
        yield failed(error);
      } finally {
        await close();
      }
    })();
    const owned = abortFirstIterator(events, () => abort.abort());
    return {
      ok: true,
      sessionId: result.sessionId,
      message: result.message,
      duplicate: result.duplicate,
      events: {
        [Symbol.asyncIterator]: () => ({
          next: () => owned.next(),
          async return() {
            await owned.return?.();
            await close();
            return { done: true, value: undefined };
          },
          async throw(error) {
            try {
              await owned.return?.();
            } finally {
              await close();
            }
            throw error;
          },
        }),
      },
    };
  } catch (error) {
    // A failure after the receipt affects observation only; uncertainty belongs only to an invoke without one.
    await iterator.return?.();
    if (receipt !== undefined) {
      return {
        ok: true,
        ...receipt,
        events: {
          async *[Symbol.asyncIterator]() {
            yield failed(error);
          },
        },
      };
    }
    return sent
      ? { ok: false, unknown: { reason: reason(error), sessionId: request.sessionId } }
      : { ok: false, error: agentError("unavailable", reason(error)) };
  }
}

async function snapshotOf(iterator: AsyncIterator<ResumeEvent>, entries?: Entry[]): Promise<AgentError | undefined> {
  for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
    const event = next.value;
    if (event.type === "state") return undefined;
    if (event.type === "entry") entries?.push(event.entry);
    if (event.type === "rejected" || event.type === "serving_error") return event.error;
  }
  return agentError("unavailable", "The session ended before its snapshot arrived");
}

async function* answerEntries(
  agent: Agent,
  sessionId: string,
  message: DoneMessage,
  signal: AbortSignal,
): AsyncGenerator<SessionEvent> {
  let after = message.entryId;
  while (after !== undefined) {
    const page = await Effect.runPromise(
      port(() => agent.read(sessionId, { after, limit: 500 })),
      { signal },
    );
    if (!page.ok) throw new AgentRejection(page.error);
    for (const entry of page.entries) {
      yield { type: "entry", entry };
      if (entry.id === message.answer?.entryId) return;
    }
    after = page.next;
  }
  throw new Error("The message's answer entry could not be found");
}
