/**
 * The client half of an event stream (sse-client.ts), through the remote SPEC v1 Agent: the connect budget that tells
 * a black hole from a slow host, and the idle watchdog that measures pending reads and is reset by heartbeats.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FollowEvent, InvokeEvent } from "../src/protocol.ts";
import { connectAgent } from "../src/protocol-remote.ts";

/**
 * THE fake `fetch`, because a hand-written one keeps forgetting the same clause: a real `fetch` ends its work when the
 * caller aborts. A fake that ignores `init.signal` still serves every test that only reads bytes, and silently passes
 * every claim about when the client does or does not tear a connection down.
 */
function fakeSse(options: { status?: number; connects?: boolean } = {}): {
  fetchFn: typeof fetch;
  /** Feed one SSE block; before anything connects it is queued. */
  push(block: string): void;
} {
  const encoder = new TextEncoder();
  const queued: string[] = [];
  let feed: ReadableStreamDefaultController<Uint8Array> | undefined;
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(input)).pathname === "/agent") {
      return new Response("{}", { headers: { "content-type": "application/json" } });
    }
    // A signal that is ALREADY aborted never reaches a listener, and a real fetch rejects on the spot.
    if (init?.signal?.aborted) return Promise.reject(init.signal.reason);
    if (options.connects === false) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    }
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        feed = controller;
        for (const block of queued.splice(0)) controller.enqueue(encoder.encode(block));
        // THE clause: a body outlives its caller only until the caller says stop.
        init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
      },
    });
    return new Response(body, { status: options.status ?? 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  return { fetchFn, push: (block) => (feed ? feed.enqueue(encoder.encode(block)) : void queued.push(block)) };
}

const entry = (id: string): string =>
  `data: ${JSON.stringify({ type: "entry", entry: { id, timestamp: 0, kind: "user_message", data: {} } })}\n\n`;

async function drain<T>(events: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const event of events) out.push(event);
  return out;
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("the connect budget", () => {
  it("a connect that never completes ends a follow in 10s and an invoke in 60s", async () => {
    vi.useFakeTimers();
    const agent = await connectAgent({ url: "http://hole", fetchFn: fakeSse({ connects: false }).fetchFn });
    const followed = drain(agent.sessions.get("s").follow());
    // The invoke plane has its own limit: a scale-to-zero host holds a POST open while its machine boots, so it must
    // not inherit the follow's 10s.
    const invoked = drain(agent.invoke({ sessionId: "s", prompt: { text: "hi" } }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await followed).toEqual([
      {
        type: "rejected",
        error: expect.objectContaining({
          code: "unavailable",
          message: expect.stringContaining("no usable response in 10s"),
        }),
      },
    ]);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(await invoked).toEqual([
      { type: "serving_error", message: expect.stringContaining("no usable response in 60s") },
    ]);
  });

  it("headers that answer with a body that never does stay on the connect budget", async () => {
    // The half-dead tunnel: clearing the connect deadline at the headers would leave the read to the 90s idle limit.
    vi.useFakeTimers();
    const agent = await connectAgent({ url: "http://tunnel", fetchFn: fakeSse({ status: 502 }).fetchFn });
    const followed = drain(agent.sessions.get("s").follow());
    const invoked = drain(agent.invoke({ sessionId: "s", prompt: { text: "hi" } }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await followed).toEqual([
      {
        type: "rejected",
        error: expect.objectContaining({ message: expect.stringContaining("no usable response in 10s") }),
      },
    ]);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(await invoked).toEqual([
      { type: "serving_error", message: expect.stringContaining("no usable response in 60s") },
    ]);
  });

  it("a consumer that walks away before the connect ends its stream with no event", async () => {
    const agent = await connectAgent({ url: "http://quiet", fetchFn: fakeSse({ connects: false }).fetchFn });
    const iterator = agent.sessions.get("s").follow()[Symbol.asyncIterator]();
    const pull = iterator.next();
    await iterator.return?.(undefined);
    expect(await pull).toMatchObject({ done: true });
  });
});

describe("the idle watchdog", () => {
  it("ends with the connect: a heartbeating stream survives long past the connect limit", async () => {
    // Keeping the 10s connect limit on a connected stream would end every healthy one: the server heartbeats every 30s.
    vi.useFakeTimers();
    const { fetchFn, push } = fakeSse();
    const agent = await connectAgent({ url: "http://slow", fetchFn });
    const iterator = agent.sessions.get("s").follow()[Symbol.asyncIterator]();
    const seen: FollowEvent[] = [];
    const watching = (async () => {
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        seen.push(next.value);
      }
    })();
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
      push(": ping\n\n");
      await vi.advanceTimersByTimeAsync(0);
    }
    push(entry("e1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([expect.objectContaining({ type: "entry" })]);
    await iterator.return?.(undefined);
    await watching;
  });

  it("ends a connection that sends nothing, not even a heartbeat, for 90s", async () => {
    vi.useFakeTimers();
    const { fetchFn, push } = fakeSse();
    const agent = await connectAgent({ url: "http://dead", fetchFn });
    push(entry("e1"));
    const followed = drain(agent.sessions.get("s").follow());
    await vi.advanceTimersByTimeAsync(90_000);
    expect(await followed).toEqual([
      expect.objectContaining({ type: "entry" }),
      { type: "serving_error", message: expect.stringContaining("dead connection") },
    ]);
  });

  it("a paused consumer never trips it: it measures pending reads, not pull progress", async () => {
    // A consumer parked between reads (rate-limited rendering, a debugger) has no pending read; a healthy connection
    // must not be read as dead.
    vi.useFakeTimers();
    const { fetchFn, push } = fakeSse();
    const agent = await connectAgent({ url: "http://x", fetchFn });
    const iterator = agent.invoke({ sessionId: "s", prompt: { text: "hi" } })[Symbol.asyncIterator]();
    push(`data: ${JSON.stringify({ type: "accepted", sessionId: "s", run: { runId: "r", status: "running" } })}\n\n`);
    expect(((await iterator.next()).value as InvokeEvent).type).toBe("accepted");
    await vi.advanceTimersByTimeAsync(4 * 30_000);
    const resumed = iterator.next();
    push(entry("e1"));
    expect(((await resumed).value as InvokeEvent).type).toBe("entry");
    await iterator.return?.(undefined);
  });
});
