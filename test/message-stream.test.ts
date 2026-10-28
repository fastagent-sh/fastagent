/** `messages.stream` over its sources: what a failure it cannot recover from becomes once the message is delivered. */
import { expect, it } from "vitest";
import { type MessageStreamEvent, type SessionEvent, agentError } from "../src/agent-api.ts";
import { type StreamSource, messageStream } from "../src/harnesses/pi-durable/stream.ts";

const running = { id: "m", sessionId: "s", status: "running", entryId: "e1" } as const;
const opening = { id: "e1", timestamp: 0, kind: "user", data: { content: [], messageId: "m" } };

it("delivers a running message whose session cannot be watched again as a stream_error, never a rejection", async () => {
  let watched = 0;
  const source: StreamSource = {
    events: () => ({
      [Symbol.asyncIterator]: () => {
        // The first watch is the one taken before the send; the second, after the message's own entry, fails.
        watched++;
        if (watched === 1) {
          const snapshot: SessionEvent = {
            type: "state",
            session: { id: "s", status: "running", usage: { models: {}, tools: {} } },
          };
          return {
            next: async () => ({ done: false, value: snapshot }),
            return: async () => ({ done: true, value: undefined }),
          };
        }
        return {
          next: () => Promise.reject(agentError("unavailable", "The agent cannot answer now: the disk is gone")),
          return: async () => ({ done: true, value: undefined }),
        };
      },
    }),
    admit: async () => ({ message: running, replayed: true }),
    get: async () => running,
    entry: async () => opening,
    entries: async () => ({ data: [] }),
  };
  const events: MessageStreamEvent[] = [];
  for await (const event of messageStream(
    source,
    { sessionId: "s", content: "again", idempotencyKey: "k" },
    undefined,
  )) {
    events.push(event);
  }
  expect(events).toEqual([
    { type: "message", message: running },
    {
      type: "stream_error",
      error: { code: "unavailable", message: "The agent cannot answer now: the disk is gone", retryable: true },
    },
  ]);
});
