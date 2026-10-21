/**
 * The Agent API over HTTP: the conformance suite through the HTTP client against a real server, and what only the
 * binding has to say (statuses, SSE ids, `Last-Event-ID`, the client's answers when a reply does not arrive).
 */
import { afterAll, describe, expect, it } from "vitest";
import type { Agent, InvokeResult } from "../src/agent-api.ts";
import { connectAgentApi } from "../src/agent-api-remote.ts";
import { createAgentApiHandler } from "../src/channels/agent-api-http.ts";
import { serveNode } from "../src/channels/serve.ts";
import { type AgentApiSubject, agentApiConformance } from "./agent-api-conformance.ts";
import { durableSubject } from "./durable-subject.ts";

const servers: ReturnType<typeof serveNode>[] = [];
afterAll(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await server.close();
  }
});

/** A server whose Agent can be replaced, so a restart keeps the URL a client holds. */
async function serving(): Promise<{ url: string; use(agent: Agent): void }> {
  let handler = (_req: Request): Response | Promise<Response> => new Response("no agent yet\n", { status: 503 });
  const server = serveNode((req) => handler(req), { port: 0, host: "127.0.0.1" });
  servers.push(server);
  const url = `http://127.0.0.1:${await server.listening}`;
  return {
    url,
    use: (agent) => {
      handler = createAgentApiHandler(agent);
    },
  };
}

function overHttp(inner: AgentApiSubject): AgentApiSubject {
  const server = serving();
  const connected = async (agent: Agent) => {
    const { url, use } = await server;
    use(agent);
    return connectAgentApi({ url });
  };
  return {
    ...inner,
    start: async (options) => connected(await inner.start(options)),
    restart: async () => connected(await inner.restart()),
  };
}

agentApiConformance("pi-durable over HTTP", overHttp(durableSubject()));

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** Reads an SSE response until `enough` holds, then leaves it; returns each event's id (or `null`) and data. */
async function sse(res: Response, enough: (events: { id: string | null; data: { type: string } }[]) => boolean) {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: { id: string | null; data: { type: string; [k: string]: unknown } }[] = [];
  while (!enough(events)) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (let at = buffer.indexOf("\n\n"); at !== -1; at = buffer.indexOf("\n\n")) {
      const block = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      const data = block.split("\n").find((line) => line.startsWith("data: "));
      if (data === undefined) continue;
      const id = block.split("\n").find((line) => line.startsWith("id: "));
      events.push({ id: id === undefined ? null : id.slice(4), data: JSON.parse(data.slice(6)) });
    }
  }
  await reader.cancel();
  return events;
}

describe("the Agent API's HTTP binding", () => {
  const subject = durableSubject();
  afterAll(() => subject.stop());

  async function started() {
    const { url, use } = await serving();
    use(await subject.start());
    const agent = await connectAgentApi({ url });
    const created = await agent.createSession();
    if (!created.ok) throw new Error(JSON.stringify(created));
    return { url, agent, sessionId: created.sessionId };
  }

  async function answered(agent: Agent, sessionId: string, text: string) {
    const receipt = await agent.invoke({ sessionId, content: [{ type: "text", text }] });
    if (!receipt.ok) throw new Error(JSON.stringify(receipt));
    expect(await receipt.wait()).toMatchObject({ ok: true });
    return receipt;
  }

  it("refuses a POST without content-type: application/json before reading it, a body-less abort included", async () => {
    const { url, sessionId } = await started();
    const plain = await fetch(`${url}/invoke`, { method: "POST", body: JSON.stringify({ sessionId, content: [] }) });
    expect(plain.status).toBe(415);
    const abort = await fetch(`${url}/sessions/${encodeURIComponent(sessionId)}/abort`, { method: "POST" });
    expect(abort.status).toBe(415);
    const read = await fetch(`${url}/sessions/${encodeURIComponent(sessionId)}`);
    expect(await read.json()).toMatchObject({ entries: [] });
  });

  it("answers an invoke with 202 and the receipt, a refusal with its code's status, and an unknown field with 400", async () => {
    const { url, sessionId } = await started();
    const accepted = await fetch(`${url}/invoke`, json({ sessionId, content: [{ type: "text", text: "hi" }] }));
    expect(accepted.status).toBe(202);
    const receipt = await accepted.json();
    expect(receipt).toEqual({
      sessionId,
      message: expect.objectContaining({ messageId: expect.any(String) }),
      duplicate: false,
    });
    const unknownSession = await fetch(
      `${url}/invoke`,
      json({ sessionId: "nope", content: [{ type: "text", text: "hi" }] }),
    );
    expect(unknownSession.status).toBe(404);
    expect(await unknownSession.json()).toMatchObject({ error: { code: "not_found", retryable: false } });
    const extra = await fetch(
      `${url}/invoke`,
      json({ sessionId, content: [{ type: "text", text: "hi" }], source: "x" }),
    );
    expect(extra.status).toBe(400);
    expect(await extra.json()).toMatchObject({ error: { code: "invalid_request" } });
    const missing = await fetch(`${url}/sessions/${encodeURIComponent(sessionId)}/messages/nope`);
    expect([missing.status, await missing.json()]).toEqual([200, null]);
    expect((await fetch(`${url}/sessions/${encodeURIComponent(sessionId)}/attachments/nope`)).status).toBe(404);
  });

  it("names each entry in its SSE id, the snapshot after the newest entry, and Last-Event-ID wins over the URL", async () => {
    const { url, agent, sessionId } = await started();
    const events = `${url}/sessions/${encodeURIComponent(sessionId)}/events`;
    const empty = await sse(await fetch(events), (seen) => seen.length === 1);
    expect(empty).toEqual([{ id: "start", data: expect.objectContaining({ type: "state" }) }]);
    await answered(agent, sessionId, "one");
    await answered(agent, sessionId, "two");
    const page = await agent.read(sessionId);
    if (!page.ok) throw new Error(JSON.stringify(page));
    const ids = page.entries.map((entry) => entry.id);
    const snapshot = await sse(await fetch(events), (seen) => seen.length === 1);
    expect(snapshot).toEqual([{ id: ids.at(-1), data: expect.objectContaining({ type: "state" }) }]);
    const replayed = await sse(await fetch(`${events}?replay=start`), (seen) =>
      seen.some((e) => e.data.type === "state"),
    );
    expect(replayed.map((event) => event.id)).toEqual([...ids, ids.at(-1)]);
    const reconnect = await sse(
      await fetch(`${events}?replay=start`, { headers: { "last-event-id": ids[1] as string } }),
      (seen) => seen.some((e) => e.data.type === "state"),
    );
    expect(reconnect.map((event) => event.id)).toEqual([...ids.slice(2), ids.at(-1)]);
    const unknownCursor = await fetch(`${events}?after=nope`);
    expect(unknownCursor.status).toBe(404);
  });

  it("resumes a stream cut before its first entry from its snapshot's id, missing no entry written in between", async () => {
    const { url, agent, sessionId } = await started();
    await answered(agent, sessionId, "before");
    const events = `${url}/sessions/${encodeURIComponent(sessionId)}/events`;
    const [snapshot] = await sse(await fetch(events), (seen) => seen.length === 1);
    await answered(agent, sessionId, "between");
    const resumed = await sse(await fetch(events, { headers: { "last-event-id": snapshot?.id as string } }), (seen) =>
      seen.some((e) => e.data.type === "state"),
    );
    const page = await agent.read(sessionId);
    if (!page.ok) throw new Error(JSON.stringify(page));
    const after = page.entries.slice(page.entries.findIndex((entry) => entry.id === snapshot?.id) + 1);
    expect(after).toHaveLength(2);
    expect(resumed.filter((event) => event.data.type === "entry").map((event) => event.id)).toEqual(
      after.map((entry) => entry.id),
    );
  });

  it("keeps the server's unknown, with its ids, and never reads a lost reply as a refusal", async () => {
    const unknown: InvokeResult = {
      ok: false,
      unknown: { reason: "the receipt could not be read", sessionId: "s", messageId: "m" },
    };
    const stub = {
      info: () => ({ protocolVersion: "1.0" as const, name: "stub", inputs: ["text"], commands: [] }),
      invoke: async () => unknown,
      abort: async () => ({ ok: false as const, unknown: { reason: "storage failed" } }),
    } as unknown as Agent;
    const { url, use } = await serving();
    use(stub);
    const res = await fetch(`${url}/invoke`, json({ content: [{ type: "text", text: "hi" }] }));
    expect([res.status, await res.json()]).toEqual([503, { unknown: unknown.ok ? undefined : unknown.unknown }]);
    const agent = await connectAgentApi({ url });
    expect(await agent.invoke({ content: [{ type: "text", text: "hi" }] })).toEqual(unknown);
    expect(await agent.abort("s")).toEqual({ ok: false, unknown: { reason: "storage failed" } });

    const failing = (error: unknown): typeof fetch =>
      (async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith("/agent")) return fetch(input, init);
        throw error;
      }) as typeof fetch;
    const cut = await connectAgentApi({ url, fetchFn: failing(new TypeError("socket hang up")) });
    expect(await cut.invoke({ sessionId: "s", content: [{ type: "text", text: "hi" }] })).toMatchObject({
      ok: false,
      unknown: { sessionId: "s", reason: expect.stringContaining("socket hang up") },
    });
    expect(await cut.abort("s")).toMatchObject({ ok: false, unknown: { reason: expect.any(String) } });
    const refusedConnection = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    const down = await connectAgentApi({ url, fetchFn: failing(refusedConnection) });
    expect(await down.invoke({ content: [{ type: "text", text: "hi" }] })).toMatchObject({
      ok: false,
      error: { code: "unavailable", retryable: true },
    });
    const gateway = await connectAgentApi({
      url,
      fetchFn: (async (input: string | URL | Request, init?: RequestInit) =>
        String(input).endsWith("/agent")
          ? fetch(input, init)
          : new Response("<html>bad gateway</html>", { status: 502 })) as typeof fetch,
    });
    expect(await gateway.invoke({ content: [{ type: "text", text: "hi" }] })).toMatchObject({
      ok: false,
      unknown: { reason: expect.stringContaining("502") },
    });
  });
});
