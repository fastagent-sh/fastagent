/**
 * SPEC v1 over HTTP: the conformance suite through the remote client against a real server, and what only the binding
 * has to say (statuses, the receipt without a stream, `Last-Event-ID`, a remote `source`).
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { protocolHttp } from "../src/channels/protocol-http.ts";
import { router, serveNode } from "../src/channels/serve.ts";
import type { HarnessPort } from "../src/harness-port.ts";
import { loopPort } from "../src/loop-port.ts";
import { type Agent, type FollowEvent, LIMITS } from "../src/protocol.ts";
import { connectRemoteAgent } from "../src/protocol-remote.ts";
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

  it("refuses an unknown field instead of dropping it", async () => {
    const url = await serve(loopPort(fakeLoopHarness(new FakeStore())));
    const res = await fetch(`${url}/invoke`, invokeBody({ sessionId: "s", prompt: { text: "x" }, whenbusy: "reject" }));
    expect(res.status).toBe(400);
  });

  it("a follow the server refuses is one rejected event", async () => {
    const agent = await remote(loopPort(fakeLoopHarness(new FakeStore())));
    const events: FollowEvent[] = [];
    for await (const event of agent.sessions.get("missing").follow()) events.push(event);
    expect(events).toMatchObject([{ type: "rejected", error: { code: "not_found" } }]);
  });
});
