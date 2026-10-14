/**
 * SPEC v1 over HTTP: the conformance suite through the remote client against a real server, and what only the binding
 * has to say (statuses, the receipt without a stream, `Last-Event-ID`, a remote `source`).
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { protocolHttp } from "../src/channels/protocol-http.ts";
import { router, serveNode } from "../src/channels/serve.ts";
import type { HarnessPort } from "../src/harness-port.ts";
import { loopPort } from "../src/loop-port.ts";
import { type Agent, AgentRejection, type FollowEvent, LIMITS } from "../src/protocol.ts";
import { connectRemoteAgent } from "../src/protocol-remote.ts";
import { collect } from "../src/protocol-collect.ts";
import { servingAgent } from "../src/serving-layer.ts";
import { FakeStore, fakeLoopHarness } from "./fake-loop-harness.ts";
import { describeProtocolConformance } from "./protocol-conformance.ts";

const servers: { close(): Promise<void>; closeAllConnections(): void }[] = [];
afterAll(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await server.close();
  }
});

async function serve(port: HarnessPort): Promise<string> {
  const surface = protocolHttp(servingAgent(port));
  const handler = router({ unverified: surface.user.routes, mounts: [...surface.user.mounts, surface.control] });
  const server = serveNode(handler, { port: 0, host: "127.0.0.1" });
  servers.push(server);
  return `http://127.0.0.1:${await server.listening}`;
}

const remote = async (port: HarnessPort): Promise<Agent> => connectRemoteAgent({ url: await serve(port) });

let store = new FakeStore();

describeProtocolConformance("LoopPort over HTTP", {
  start: ({ capacity } = {}) => {
    store = new FakeStore();
    return remote(
      loopPort(fakeLoopHarness(store), {
        queuedPerSession: LIMITS.queuedPerSession,
        inFlightPerProcess: capacity ?? LIMITS.inFlightPerProcess,
      }),
    );
  },
  restart: () => {
    store.restart();
    return remote(loopPort(fakeLoopHarness(store)));
  },
  release: () => store.release(),
  effects: () => store.effects,
});

describe("the HTTP binding", () => {
  const invokeBody = (body: unknown) => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  it("refuses a remote source, answering its code's status", async () => {
    const url = await serve(loopPort(fakeLoopHarness(new FakeStore())));
    const res = await fetch(
      `${url}/invoke`,
      invokeBody({ sessionId: "s", prompt: { text: "x" }, source: { kind: "channel", name: "telegram" } }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: "invalid_request", message: expect.stringMatching(/source/) },
    });
    const agent = await connectRemoteAgent({ url });
    const events = [];
    for await (const event of agent.invoke({ sessionId: "s", prompt: { text: "x" }, source: { kind: "schedule" } })) {
      events.push(event);
    }
    expect(events).toMatchObject([{ type: "rejected", error: { code: "invalid_request" } }]);
  });

  it("answers application/json with the receipt alone, and the run goes on", async () => {
    const fake = new FakeStore();
    const url = await serve(loopPort(fakeLoopHarness(fake)));
    const res = await fetch(`${url}/invoke`, {
      ...invokeBody({ sessionId: "s", prompt: { text: "hold" } }),
      headers: { "content-type": "application/json", accept: "application/json" },
    });
    expect(res.status).toBe(202);
    const receipt = (await res.json()) as { type: string; run: { runId: string } };
    expect(receipt.type).toBe("accepted");
    fake.release();
    const agent = await connectRemoteAgent({ url });
    await vi.waitFor(async () =>
      expect(await agent.sessions.get("s").runs.get({ runId: receipt.run.runId })).toMatchObject({ status: "done" }),
    );
  });

  it("names each entry in its SSE id, and Last-Event-ID resumes after it", async () => {
    const url = await serve(loopPort(fakeLoopHarness(new FakeStore())));
    const agent = await connectRemoteAgent({ url });
    for await (const _ of agent.invoke({ sessionId: "s", prompt: { text: "one" } })) void _;
    const page = await agent.sessions.get("s").read();
    if (!page.ok) throw new Error(page.error.message);
    const [first, ...rest] = page.entries;
    const abort = new AbortController();
    const res = await fetch(`${url}/sessions/s/follow`, {
      headers: { "last-event-id": first?.id as string },
      signal: abort.signal,
    });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    let text = "";
    while ((text.match(/^data:/gm) ?? []).length < rest.length) {
      const { value } = await reader.read();
      text += new TextDecoder().decode(value);
    }
    abort.abort();
    const ids = [...text.matchAll(/^id: (.+)$/gm)].map((m) => m[1]);
    expect(ids).toEqual(rest.map((e) => e.id));
  });

  it("answers an unknown run with null and an unknown attachment with 404, and a busy session with 429", async () => {
    const fake = new FakeStore();
    const url = await serve(loopPort(fakeLoopHarness(fake)));
    const agent = await connectRemoteAgent({ url });
    for await (const _ of agent.invoke({ sessionId: "s", prompt: { text: "one" } })) void _;
    const run = await fetch(`${url}/sessions/s/runs/no-such-run`);
    expect([run.status, await run.json()]).toEqual([200, null]);
    expect((await fetch(`${url}/sessions/s/attachments/no-such-ref`)).status).toBe(404);
    const held = agent.invoke({ sessionId: "s", prompt: { text: "hold" } })[Symbol.asyncIterator]();
    await held.next();
    const busy = await fetch(
      `${url}/invoke`,
      invokeBody({ sessionId: "s", prompt: { text: "x" }, whenBusy: "reject" }),
    );
    expect(busy.status).toBe(429);
    expect(await busy.json()).toMatchObject({ error: { code: "busy", retryable: true } });
    fake.release();
    await held.return?.();
  });

  it("carries a fork's context to the harness, and refuses one it does not know", async () => {
    const harness = fakeLoopHarness(new FakeStore());
    const contexts: unknown[] = [];
    const url = await serve(
      loopPort({
        ...harness,
        create: (sessionId, onRecord, fork) => {
          if (fork) contexts.push(fork.context);
          return harness.create(sessionId, onRecord, fork);
        },
      }),
    );
    const agent = await connectRemoteAgent({ url });
    await collect(agent.invoke({ sessionId: "room", prompt: { text: "hi" } }));
    expect(await agent.sessions.create({ sessionId: "t", fork: { sessionId: "room", context: "recent" } })).toEqual({
      ok: true,
      sessionId: "t",
    });
    expect(contexts).toEqual(["recent"]);
    const bogus = await fetch(`${url}/sessions`, invokeBody({ fork: { sessionId: "room", context: "all" } }));
    expect(bogus.status).toBe(400);
  });

  it("refuses an unknown field instead of dropping it", async () => {
    const url = await serve(loopPort(fakeLoopHarness(new FakeStore())));
    const res = await fetch(`${url}/invoke`, invokeBody({ sessionId: "s", prompt: { text: "x" }, whenbusy: "reject" }));
    expect(res.status).toBe(400);
  });

  it("a follow of a session with nothing new starts at once, and ends when its caller leaves", async () => {
    const fake = new FakeStore();
    const url = await serve(loopPort(fakeLoopHarness(fake)));
    const agent = await connectRemoteAgent({ url });
    for await (const _ of agent.invoke({ sessionId: "s", prompt: { text: "one" } })) void _;
    const page = await agent.sessions.get("s").read();
    const last = page.ok ? page.entries.at(-1)?.id : undefined;
    const started = Date.now();
    const res = await fetch(`${url}/sessions/s/follow?after=${last}`, { signal: AbortSignal.timeout(2000) });
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(2000);
    await res.body?.cancel();
    const iterator = agent.sessions
      .get("s")
      .follow({ after: last as string })
      [Symbol.asyncIterator]();
    const next = iterator.next();
    for await (const _ of agent.invoke({ sessionId: "s", prompt: { text: "two" } })) void _;
    expect(await next).toMatchObject({ value: { type: "entry" } });
    await iterator.return?.();
    const queued = await fetch(`${url}/sessions/s/runs/no-such-run/events`, { signal: AbortSignal.timeout(2000) });
    expect(queued.status).toBe(404);
  });

  const lostConnection = () =>
    new TypeError("fetch failed", { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });

  /** The first `times` invokes are delivered, and their connection then fails before the reply. */
  const lostAfterSending =
    (times = 1): typeof fetch =>
    async (input, init) => {
      if (String(input).endsWith("/invoke") && times-- > 0) {
        const res = await fetch(input, init);
        await res.body?.cancel();
        throw lostConnection();
      }
      return fetch(input, init);
    };

  it("a connection lost before the receipt is settled by sending again with the key: one run, followed", async () => {
    const url = await serve(loopPort(fakeLoopHarness(new FakeStore())));
    const agent = await connectRemoteAgent({ url, fetchFn: lostAfterSending() });
    const events = [];
    for await (const event of agent.invoke({ sessionId: "s", prompt: { text: "x" }, idempotencyKey: "k" })) {
      events.push(event);
    }
    expect(events[0]).toMatchObject({ type: "accepted", sessionId: "s", joined: false });
    expect(events.at(-1)).toMatchObject({ type: "entry", entry: { kind: "run_ended" } });
    const runs = await connectRemoteAgent({ url });
    expect(await runs.sessions.get("s").runs.get({ idempotencyKey: "k" })).toMatchObject({ status: "done" });
    const page = await runs.sessions.get("s").read();
    expect(page.ok ? page.entries.filter((e) => e.kind === "user_message") : []).toHaveLength(1);
  });

  it("a request lost before it reached the server is sent again with its key, and runs once", async () => {
    const url = await serve(loopPort(fakeLoopHarness(new FakeStore())));
    let first = true;
    const lostBeforeSending: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/invoke") && first) {
        first = false;
        throw lostConnection();
      }
      return fetch(input, init);
    };
    const agent = await connectRemoteAgent({ url, fetchFn: lostBeforeSending });
    const events = [];
    for await (const event of agent.invoke({ sessionId: "s", prompt: { text: "x" }, idempotencyKey: "k" })) {
      events.push(event);
    }
    expect(events[0]).toMatchObject({ type: "accepted", duplicate: false });
    expect(events.at(-1)).toMatchObject({ type: "entry", entry: { kind: "run_ended" } });
  });

  it("a connection lost twice leaves it unknown, never rejected", async () => {
    const url = await serve(loopPort(fakeLoopHarness(new FakeStore())));
    const agent = await connectRemoteAgent({ url, fetchFn: lostAfterSending(2) });
    const events = [];
    for await (const event of agent.invoke({ sessionId: "s", prompt: { text: "x" }, idempotencyKey: "k" })) {
      events.push(event);
    }
    expect(events).toMatchObject([{ type: "serving_error", message: expect.stringMatching(/unknown/) }]);
  });

  it("without a key, a connection lost before the receipt is not called rejected", async () => {
    const url = await serve(loopPort(fakeLoopHarness(new FakeStore())));
    const agent = await connectRemoteAgent({ url, fetchFn: lostAfterSending() });
    const events = [];
    for await (const event of agent.invoke({ sessionId: "s", prompt: { text: "x" } })) events.push(event);
    expect(events).toMatchObject([{ type: "serving_error", message: expect.stringMatching(/unknown/) }]);
  });

  it("a request that never reached the server is rejected, safe to send again", async () => {
    const url = await serve(loopPort(fakeLoopHarness(new FakeStore())));
    const refusedConnection: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/invoke")) {
        throw new TypeError("fetch failed", { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) });
      }
      return fetch(input, init);
    };
    const agent = await connectRemoteAgent({ url, fetchFn: refusedConnection });
    const events = [];
    for await (const event of agent.invoke({ sessionId: "s", prompt: { text: "x" } })) events.push(event);
    expect(events).toMatchObject([{ type: "rejected", error: { code: "unavailable", retryable: true } }]);
  });

  it("a 2xx that is not this protocol's is a failure value, not a thrown error", async () => {
    const url = await serve(loopPort(fakeLoopHarness(new FakeStore())));
    const proxied: typeof fetch = async (input, init) =>
      String(input).endsWith("/agent") ? fetch(input, init) : new Response("<html>maintenance</html>", { status: 200 });
    const agent = await connectRemoteAgent({ url, fetchFn: proxied });
    const session = agent.sessions.get("s");
    expect(await session.read()).toMatchObject({ ok: false, error: { code: "internal" } });
    await expect(session.runs.get({ runId: "r" })).rejects.toBeInstanceOf(AgentRejection);
    await expect(agent.sessions.list()).rejects.toMatchObject({ code: "internal" });
  });

  it("an attachment keeps its declared type, served under a safe one", async () => {
    const port = loopPort(fakeLoopHarness(new FakeStore()));
    const url = await serve({ ...port, attachment: async () => ({ mimeType: "image/svg+xml", data: btoa("<svg/>") }) });
    const raw = await fetch(`${url}/sessions/s/attachments/e1%3A0`);
    expect(raw.headers.get("content-type")).toBe("application/octet-stream");
    const agent = await connectRemoteAgent({ url });
    expect(await agent.sessions.get("s").attachment("e1:0")).toEqual({
      mimeType: "image/svg+xml",
      data: btoa("<svg/>"),
    });
  });

  it("an agent it cannot reach is refused as unavailable", async () => {
    const down: typeof fetch = async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) });
    };
    await expect(connectRemoteAgent({ url: "http://127.0.0.1:1", fetchFn: down })).rejects.toMatchObject({
      code: "unavailable",
      retryable: true,
    });
  });

  it("a stream cut off before its end says so, and data that is not an event is not read as one", async () => {
    const url = await serve(loopPort(fakeLoopHarness(new FakeStore())));
    const sse = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    const accepted = { type: "accepted", sessionId: "s", run: { runId: "r", status: "running" }, joined: false };
    const cutOff: typeof fetch = async (input, init) =>
      String(input).endsWith("/invoke") ? sse(`data: ${JSON.stringify(accepted)}\n\n`) : fetch(input, init);
    const cut = await connectRemoteAgent({ url, fetchFn: cutOff });
    const events = [];
    for await (const event of cut.invoke({ sessionId: "s", prompt: { text: "x" } })) events.push(event);
    expect(events.map((e) => e.type)).toEqual(["accepted", "serving_error"]);
    const garbage: typeof fetch = async (input, init) =>
      String(input).endsWith("/invoke") ? sse("data: null\n\n") : fetch(input, init);
    const odd = await connectRemoteAgent({ url, fetchFn: garbage });
    const oddEvents = [];
    for await (const event of odd.invoke({ sessionId: "s", prompt: { text: "x" } })) oddEvents.push(event);
    expect(oddEvents).toMatchObject([{ type: "serving_error", message: expect.stringMatching(/not an event/) }]);
  });

  it("a reconnect resumes after the newest id it received, not the cursor in the URL it reopens", async () => {
    const url = await serve(loopPort(fakeLoopHarness(new FakeStore())));
    const agent = await connectRemoteAgent({ url });
    for await (const _ of agent.invoke({ sessionId: "s", prompt: { text: "one" } })) void _;
    const page = await agent.sessions.get("s").read();
    if (!page.ok) throw new Error(page.error.message);
    const [opened, received, ...rest] = page.entries;
    const abort = new AbortController();
    const res = await fetch(`${url}/sessions/s/follow?after=${opened?.id}`, {
      headers: { "last-event-id": received?.id as string },
      signal: abort.signal,
    });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    let text = "";
    while ((text.match(/^data:/gm) ?? []).length < rest.length) {
      const { value } = await reader.read();
      text += new TextDecoder().decode(value);
    }
    abort.abort();
    expect([...text.matchAll(/^id: (.+)$/gm)].map((m) => m[1])).toEqual(rest.map((e) => e.id));
  });

  it("a follow the server refuses is one rejected event", async () => {
    const agent = await remote(loopPort(fakeLoopHarness(new FakeStore())));
    const events: FollowEvent[] = [];
    for await (const event of agent.sessions.get("missing").follow()) events.push(event);
    expect(events).toMatchObject([{ type: "rejected", error: { code: "not_found" } }]);
  });
});
