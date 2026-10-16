/** The SSE response lifecycle every streaming route answers with (channels/sse.ts). */
import { describe, expect, it, vi } from "vitest";
import { SSE_HEARTBEAT_MS, sseResponse } from "../src/channels/sse.ts";

describe("SSE response lifecycle", () => {
  const respond = async (source: AsyncIterable<unknown>): Promise<Response> => sseResponse(source);

  it("heartbeats a quiet stream, and cancelling it stops the heartbeat", async () => {
    // The client watchdog (90s with no bytes ends the connection) assumes the server pings every 30s; a regression on
    // this side would read every long tool call as a dead connection.
    vi.useFakeTimers();
    try {
      const hang = () => new Promise<never>(() => {});
      const res = await respond({
        [Symbol.asyncIterator]: () => ({ next: hang, return: async () => ({ done: true as const, value: undefined }) }),
      });
      const reader = res.body?.getReader();
      if (!reader) throw new Error("no body");
      const read = reader.read();
      await vi.advanceTimersByTimeAsync(SSE_HEARTBEAT_MS);
      expect(new TextDecoder().decode((await read).value)).toBe(": ping\n\n");
      await reader.cancel();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("closes the source and heartbeat when a pull fails", async () => {
    vi.useFakeTimers();
    const returned = vi.fn(async () => ({ done: true as const, value: undefined }));
    try {
      const res = await respond({
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            throw new Error("source failed");
          },
          return: returned,
        }),
      });
      await expect(res.text()).rejects.toThrow("source failed");
      expect(returned).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("closes the source and heartbeat when serialization fails", async () => {
    vi.useFakeTimers();
    const returned = vi.fn(async () => ({ done: true as const, value: undefined }));
    try {
      const res = await respond({
        [Symbol.asyncIterator]: () => ({
          next: async () => ({
            done: false,
            value: {
              toJSON() {
                throw new Error("serialization failed");
              },
            },
          }),
          return: returned,
        }),
      });
      await expect(res.text()).rejects.toThrow("serialization failed");
      expect(returned).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("preserves both an asynchronous source error and a cleanup failure", async () => {
    const sourceError = new Error("source failed");
    const cleanupError = new Error("cleanup failed");
    const res = await respond({
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          throw sourceError;
        },
        return: async () => {
          throw cleanupError;
        },
      }),
    });
    await expect(res.text()).rejects.toMatchObject({ cause: sourceError, errors: [sourceError, cleanupError] });
  });

  it("ignores a pending pull that settles after cancellation", async () => {
    let settle!: (value: IteratorResult<unknown>) => void;
    const pending = new Promise<IteratorResult<unknown>>((resolve) => {
      settle = resolve;
    });
    const toJSON = vi.fn(() => ({ type: "message_delta", delta: "late" }));
    const returned = vi.fn(async () => {
      settle({ done: false, value: { toJSON } });
      return { done: true as const, value: undefined };
    });
    const res = await respond({
      [Symbol.asyncIterator]: () => ({ next: () => pending, return: returned }),
    });
    const reader = res.body!.getReader();
    const read = reader.read();
    await reader.cancel();
    await expect(read).resolves.toMatchObject({ done: true });
    expect(returned).toHaveBeenCalledOnce();
    expect(toJSON).not.toHaveBeenCalled();
  });
});
