import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  type Agent,
  AgentError,
  type AgentErrorData,
  type ErrorCode,
  type Message,
  type MessageStatus,
  type Session,
  agentError,
  errorData,
} from "../src/agent-api.ts";
import { serveHandler } from "../src/channels/serve.ts";
import { connectAgent } from "../src/http/client.ts";
import { OpenApi } from "effect/http-api";
import { AgentHttpApi, statusOf } from "../src/http/contract.ts";
import { log } from "../src/log.ts";
import { agentApiConformance } from "./agent-api-conformance.ts";
import { durableSubject } from "./durable-subject.ts";
import { KEY, type Served, httpSubject, served } from "./http-subject.ts";
import { scriptedAgent } from "./scripted-agent.ts";
import { scriptedRun } from "./scripted-run.ts";

agentApiConformance("pi-durable, over HTTP", httpSubject(durableSubject()));

const auth = (key = KEY) => ({ authorization: `Bearer ${key}`, "content-type": "application/json" });

/** A server of the test's own, for what `connectAgent` must make of answers ours never gives. */
async function fakeServer(handler: (request: Request) => Response | Promise<Response>) {
  const server = serveHandler(handler, { port: 0, host: "127.0.0.1" });
  const port = await server.listening;
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

describe("the Agent API over HTTP", () => {
  const subject = durableSubject();
  let agent: Agent;
  let server: Served;
  beforeEach(async () => {
    agent = await subject.start();
    server = await served(agent, { keys: [KEY, "the-next-key"] });
  });
  afterEach(async () => {
    await server.close();
    await subject.stop();
  });

  it("refuses a request without a key or with one the instance does not hold, and takes each key it holds", async () => {
    // Every route the contract has, so one added where the key's middleware does not reach it fails here.
    const routes = Object.entries(OpenApi.fromApi(AgentHttpApi).paths).flatMap(([path, operations]) =>
      Object.keys(operations as object).map((method) => ({ method: method.toUpperCase(), path })),
    );
    expect(routes.length).toBeGreaterThan(10);
    for (const { method, path } of routes) {
      for (const headers of [{}, auth("not-a-key")]) {
        const response = await fetch(`${server.url}${path.replaceAll(/\{\w+\}/g, "x")}`, {
          method,
          headers,
          ...(method === "GET" ? {} : { body: "{}" }),
        });
        expect([method, path, response.status]).toEqual([method, path, 401]);
        expect(await response.json()).toMatchObject({ error: { code: "unauthorized", retryable: false } });
      }
    }
    for (const key of [KEY, "the-next-key"]) {
      expect((await fetch(`${server.url}/v1/agent`, { headers: auth(key) })).status).toBe(200);
    }
    expect((await fetch(`${server.url}/v1/openapi.json`)).status).toBe(401);
    const document = (await (await fetch(`${server.url}/v1/openapi.json`, { headers: auth() })).json()) as {
      openapi: string;
      paths: Record<string, unknown>;
    };
    expect(document.openapi).toBe("3.1.0");
    expect(Object.keys(document.paths).sort()).toEqual([
      "/v1/agent",
      "/v1/openapi.json",
      "/v1/sessions",
      "/v1/sessions/{sessionId}",
      "/v1/sessions/{sessionId}/attachments/{ref}",
      "/v1/sessions/{sessionId}/cancel",
      "/v1/sessions/{sessionId}/compact",
      "/v1/sessions/{sessionId}/entries",
      "/v1/sessions/{sessionId}/events",
      "/v1/sessions/{sessionId}/messages",
      "/v1/sessions/{sessionId}/messages/by-key/{idempotencyKey}",
      "/v1/sessions/{sessionId}/messages/{messageId}",
      "/v1/usage",
    ]);
  });

  it("answers what it cannot read invalid_request, a body over 32 MiB too_large, and a route it lacks not_found", async () => {
    const { id } = await agent.sessions.create();
    const post = (body: string) =>
      fetch(`${server.url}/v1/sessions/${id}/messages`, { method: "POST", headers: auth(), body });
    for (const body of ["{", JSON.stringify({ content: [] }), JSON.stringify({ content: "hi", wait: -1 })]) {
      const response = await post(body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    }
    const badKey = await fetch(`${server.url}/v1/sessions/${id}/messages`, {
      method: "POST",
      headers: { ...auth(), "idempotency-key": "100%" },
      body: JSON.stringify({ content: "hi" }),
    });
    expect([badKey.status, await badKey.json()]).toEqual([
      400,
      { error: expect.objectContaining({ code: "invalid_request" }) },
    ]);
    // curl's -d sends a form unless told otherwise.
    for (const type of ["application/x-www-form-urlencoded", "text/plain"]) {
      const response = await fetch(`${server.url}/v1/sessions`, {
        method: "POST",
        headers: { authorization: `Bearer ${KEY}`, "content-type": type },
        body: "{}",
      });
      expect([response.status, await response.json()]).toEqual([
        400,
        { error: expect.objectContaining({ code: "invalid_request" }) },
      ]);
    }
    const large = await post(JSON.stringify({ content: "x".repeat(33 << 20) }));
    expect(large.status).toBe(413);
    expect(await large.json()).toMatchObject({ error: { code: "invalid_request", details: { reason: "too_large" } } });
    // A request whose options may be left out may come without a body, as from `curl -X POST`.
    const bare = { method: "POST", headers: { authorization: `Bearer ${KEY}` } };
    expect((await fetch(`${server.url}/v1/sessions`, bare)).status).toBe(201);
    expect((await fetch(`${server.url}/v1/sessions/${id}/compact`, bare)).status).toBe(202);
    const missing = await fetch(`${server.url}/v1/nothing-here`, { headers: auth() });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "not_found" } });
    expect((await agent.sessions.entries(id)).data).toEqual([]);
  });

  it("gives an entry event its id and no other event one, and continues from Last-Event-ID over ?after=start", async () => {
    const { id } = await agent.sessions.create();
    await agent.messages.send({ sessionId: id, content: "hi" }, { wait: 30 });
    const [first, second] = (await agent.sessions.entries(id)).data;
    const frames = async (headers: Record<string, string>) => {
      const response = await fetch(`${server.url}/v1/sessions/${id}/events?after=start`, { headers });
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      let text = "";
      while (!text.includes("event: state")) text += new TextDecoder().decode((await reader.read()).value);
      await reader.cancel();
      return text.split("\n\n").filter((frame) => frame.startsWith("id:") || frame.startsWith("event:"));
    };
    expect(await frames(auth())).toEqual([
      expect.stringMatching(new RegExp(`^id: ${first?.id}\nevent: entry\n`)),
      expect.stringMatching(new RegExp(`^id: ${second?.id}\nevent: entry\n`)),
      expect.stringMatching(/^event: state\n/),
    ]);
    expect(await frames({ ...auth(), "last-event-id": first?.id as string })).toEqual([
      expect.stringMatching(new RegExp(`^id: ${second?.id}\n`)),
      expect.stringMatching(/^event: state\n/),
    ]);
  });
});

describe("the Agent API's HTTP limits", () => {
  const subject = durableSubject();
  afterEach(() => subject.stop());

  it("caps a wait at the server's limit, which connectAgent asks again past until its Caller's wait is met", async () => {
    const agent = await subject.start();
    let asked = 0;
    const server = await served(agent, { waitCapSeconds: 0.2, heard: () => asked++ });
    try {
      const { id: sessionId } = await agent.sessions.create();
      const message = await agent.messages.send({ sessionId, content: "hold" });
      let started = Date.now();
      const capped = await fetch(`${server.url}/v1/sessions/${sessionId}/messages/${message.id}?wait=5`, {
        headers: auth(),
      });
      expect(Date.now() - started).toBeLessThan(2000);
      expect(await capped.json()).toMatchObject({ status: "running" });
      asked = 0;
      started = Date.now();
      const waited = await connectAgent(server.url, { apiKey: KEY }).messages.get(
        { sessionId, messageId: message.id },
        { wait: 0.7 },
      );
      expect(waited.status).toBe("running");
      expect(Date.now() - started).toBeGreaterThanOrEqual(650);
      expect(asked).toBeGreaterThanOrEqual(3);
      subject.release();
    } finally {
      await server.close();
    }
  });

  it("rejects a send whose wait past the cap failed unconfirmed with its message, as in process", async () => {
    const agent = await subject.start();
    const server = await served(agent, {
      waitCapSeconds: 0.1,
      // The first request is the send; the storage is gone by the one that asks again.
      heard: (request) => {
        if (request.method === "GET") subject.failStorage();
      },
    });
    try {
      const { id: sessionId } = await agent.sessions.create();
      const error = await connectAgent(server.url, { apiKey: KEY })
        .messages.send({ sessionId, content: "hold", idempotencyKey: "k" }, { wait: 5 })
        .catch((rejection: unknown) => rejection);
      expect(error).toMatchObject({
        code: "unconfirmed",
        retryable: false,
        details: { sessionId, messageId: expect.any(String), idempotencyKey: "k" },
      });
    } finally {
      await server.close();
    }
  });

  it("says a quiet event stream is open with a comment", async () => {
    const agent = await subject.start();
    const server = await served(agent, { keepAliveMs: 50 });
    try {
      const { id } = await agent.sessions.create();
      const response = await fetch(`${server.url}/v1/sessions/${id}/events`, { headers: auth() });
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      let text = "";
      while (!/^: .*\n\n.*: /s.test(text)) text += new TextDecoder().decode((await reader.read()).value);
      await reader.cancel();
    } finally {
      await server.close();
    }
  });
});

describe("refusals over HTTP", () => {
  afterEach(() => vi.restoreAllMocks());

  it("answers each code with the status §7 names", () => {
    const cases: [ErrorCode | "a_later_code", unknown, number][] = [
      ["invalid_request", undefined, 400],
      ["invalid_request", { reason: "too_large" }, 413],
      ["unauthorized", undefined, 401],
      ["not_found", undefined, 404],
      ["busy", { reason: "running" }, 409],
      ["busy", { reason: "queue_full" }, 429],
      ["busy", { reason: "capacity" }, 503],
      ["missing_model", undefined, 409],
      ["missing_tool", { tools: ["x"] }, 409],
      ["unconfirmed", { messageId: "m" }, 500],
      ["unavailable", undefined, 503],
      ["internal", undefined, 500],
      ["a_later_code", undefined, 500],
    ];
    for (const [code, details, status] of cases) {
      const error = { code, message: code, retryable: false, ...(details === undefined ? {} : { details }) };
      expect([code, statusOf(error as AgentErrorData)]).toEqual([code, status]);
    }
  });

  it("answers an answer of its own that does not match the API internal, said in the log, not invalid_request", async () => {
    const said = vi.spyOn(log, "error").mockImplementation(() => {});
    const scripted = scriptedAgent((request) => scriptedRun(request));
    const agent: Agent = {
      ...scripted,
      sessions: {
        ...scripted.sessions,
        get: async (id) => ({ id, status: "idle", thinkingLevel: "ultra" as never, usage: { models: {}, tools: {} } }),
      },
    };
    const server = await served(agent);
    try {
      const response = await fetch(`${server.url}/v1/sessions/s`, { headers: auth() });
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ error: { code: "internal", retryable: false } });
      expect(said).toHaveBeenCalledWith(expect.stringContaining("[api] an answer did not match the Agent API"));
    } finally {
      await server.close();
    }
  });

  it("ends an event stream whose next event the API cannot send with stream_error internal, said in the log", async () => {
    const said = vi.spyOn(log, "error").mockImplementation(() => {});
    const scripted = scriptedAgent((request) => scriptedRun(request));
    const session = { id: "s", status: "idle", usage: { models: {}, tools: {} } };
    const agent: Agent = {
      ...scripted,
      sessions: {
        ...scripted.sessions,
        events: () =>
          (async function* () {
            yield { type: "state" as const, session };
            yield { type: "entry" as const, entry: { id: 7 } as never };
          })(),
      },
    };
    const server = await served(agent);
    try {
      const events = connectAgent(server.url, { apiKey: KEY }).sessions.events("s")[Symbol.asyncIterator]();
      expect((await events.next()).value).toMatchObject({ type: "state" });
      expect((await events.next()).value).toMatchObject({
        type: "stream_error",
        error: { code: "internal", retryable: false },
      });
      expect(said).toHaveBeenCalledWith(expect.stringContaining("[api] sessions.events failed"));
    } finally {
      await server.close();
    }
  });

  it("sends Retry-After with a refusal a Caller may try again later, and connectAgent rejects with it as sent", async () => {
    const refusals: AgentErrorData[] = [
      errorData(agentError("busy", "the queue is full", { reason: "queue_full" })),
      errorData(agentError("unavailable", "the storage cannot answer")),
      errorData(agentError("not_found", "no such session")),
    ];
    let next = 0;
    const agent = scriptedAgent((request) => scriptedRun(request, { rejected: refusals[next++] as AgentErrorData }));
    const server = await served(agent);
    try {
      for (const [status, retryAfter] of [
        [429, "1"],
        [503, "1"],
        [404, null],
      ] as const) {
        const response = await fetch(`${server.url}/v1/sessions/s/messages`, {
          method: "POST",
          headers: auth(),
          body: JSON.stringify({ content: "hi" }),
        });
        expect([response.status, response.headers.get("retry-after")]).toEqual([status, retryAfter]);
      }
      next = 0;
      await expect(
        connectAgent(server.url, { apiKey: KEY }).messages.send({ sessionId: "s", content: "hi" }),
      ).rejects.toEqual(new AgentError(refusals[0] as AgentErrorData));
    } finally {
      await server.close();
    }
  });
});

describe("connectAgent", () => {
  it("takes an error code, an event type and a status it does not know (§7.1)", async () => {
    let asked = 0;
    const server = await fakeServer((request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/events")) {
        return new Response(
          'event: fastagent.plan\ndata: {"type":"fastagent.plan"}\n\n' +
            'event: state\ndata: {"type":"state","session":{"id":"s","status":"paused","usage":{"models":{},"tools":{}}}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      if (path.includes("/messages/")) {
        asked++;
        return Response.json({ id: "m", sessionId: "s", status: "waiting" });
      }
      return Response.json({ error: { code: "a_later_code", message: "new", retryable: true } }, { status: 409 });
    });
    try {
      const agent = connectAgent(server.url, { apiKey: KEY });
      await expect(agent.sessions.get("s")).rejects.toMatchObject({ code: "a_later_code", retryable: true });
      // As types, the statuses still name the known values, beside any other.
      expectTypeOf<Session["status"]>().toEqualTypeOf<"idle" | "running" | (string & {})>();
      expectTypeOf<Message["status"]>().toEqualTypeOf<MessageStatus | (string & {})>();
      // A status it does not know is a message that has not ended: it is waited for, and asked after again.
      expect(await agent.messages.get({ sessionId: "s", messageId: "m" }, { wait: 0.3 })).toMatchObject({
        status: "waiting",
      });
      expect(asked).toBeGreaterThanOrEqual(2);
      const events = agent.sessions.events("s")[Symbol.asyncIterator]();
      const first = (await events.next()).value;
      expect(first, JSON.stringify(first)).toMatchObject({ type: "state", session: { status: "paused" } });
      await events.return?.();
    } finally {
      await server.close();
    }
  });

  it("reads a refusal at a status it does not declare from its body, as a later server sends one (§7.1)", async () => {
    const server = await fakeServer(() =>
      Response.json({ error: { code: "quota_exceeded", message: "over", retryable: true } }, { status: 402 }),
    );
    try {
      const agent = connectAgent(server.url, { apiKey: KEY });
      const refusal = { code: "quota_exceeded", retryable: true };
      await expect(agent.sessions.get("s")).rejects.toMatchObject(refusal);
      await expect(agent.messages.send({ sessionId: "s", content: "hi" })).rejects.toMatchObject(refusal);
      await expect(
        agent.messages.stream({ sessionId: "s", content: "hi" })[Symbol.asyncIterator]().next(),
      ).rejects.toMatchObject(refusal);
    } finally {
      await server.close();
    }
  });

  it("takes an answer it cannot read, a proxy's page say, for a send that may have been recorded", async () => {
    let answer = () => new Response("<html>bad gateway</html>", { status: 520 });
    const server = await fakeServer(() => answer());
    try {
      const agent = connectAgent(server.url, { apiKey: KEY });
      const lost = { code: "unconfirmed", details: { sessionId: "s", idempotencyKey: expect.any(String) } };
      await expect(agent.messages.send({ sessionId: "s", content: "hi" })).rejects.toMatchObject(lost);
      await expect(
        agent.messages.stream({ sessionId: "s", content: "hi" })[Symbol.asyncIterator]().next(),
      ).rejects.toMatchObject(lost);
      // A read may be asked again after a server's error, and is the server's fault otherwise.
      await expect(agent.sessions.get("s")).rejects.toMatchObject({ code: "unavailable", retryable: true });
      answer = () => new Response("<html>not here</html>", { status: 404 });
      await expect(agent.sessions.get("s")).rejects.toMatchObject({ code: "internal", retryable: false });
      answer = () => new Response("{ not json", { status: 200, headers: { "content-type": "application/json" } });
      await expect(agent.messages.send({ sessionId: "s", content: "hi" })).rejects.toMatchObject(lost);
    } finally {
      await server.close();
    }
  });

  it("gives the agent's own unconfirmed the key the send carried, the client's own included", async () => {
    const server = await fakeServer(() =>
      Response.json(
        { error: { code: "unconfirmed", message: "recording failed", retryable: false, details: { sessionId: "s" } } },
        { status: 500 },
      ),
    );
    try {
      const agent = connectAgent(server.url, { apiKey: KEY });
      const unconfirmed = { code: "unconfirmed", details: { sessionId: "s", idempotencyKey: expect.any(String) } };
      await expect(agent.messages.send({ sessionId: "s", content: "hi" })).rejects.toMatchObject(unconfirmed);
      await expect(
        agent.messages.stream({ sessionId: "s", content: "hi" })[Symbol.asyncIterator]().next(),
      ).rejects.toMatchObject(unconfirmed);
    } finally {
      await server.close();
    }
  });

  it("rejects a stream's first read unconfirmed when its answer ends or cannot be read before its first event", async () => {
    let body = "";
    const server = await fakeServer(() => new Response(body, { headers: { "content-type": "text/event-stream" } }));
    try {
      const agent = connectAgent(server.url, { apiKey: KEY });
      const first = () => agent.messages.stream({ sessionId: "s", content: "hi" })[Symbol.asyncIterator]().next();
      const unconfirmed = { code: "unconfirmed", details: { sessionId: "s", idempotencyKey: expect.any(String) } };
      await expect(first()).rejects.toMatchObject(unconfirmed);
      body = 'data: {"type":"message","message":{"id":7,"sessionId":"s","status":"queued"}}\n\n';
      await expect(first()).rejects.toMatchObject(unconfirmed);
    } finally {
      await server.close();
    }
  });

  it("rejects a send it could not deliver unconfirmed with its key, and a read unavailable", async () => {
    const server = await fakeServer(() => new Response("ok"));
    await server.close();
    const agent = connectAgent(server.url, { apiKey: KEY });
    await expect(agent.messages.send({ sessionId: "s", content: "hi", idempotencyKey: "k" })).rejects.toMatchObject({
      code: "unconfirmed",
      details: { sessionId: "s", idempotencyKey: "k" },
    });
    const keyed = await agent.messages.send({ sessionId: "s", content: "hi" }).catch((error: unknown) => error);
    expect(keyed).toMatchObject({ code: "unconfirmed", details: { idempotencyKey: expect.any(String) } });
    await expect(agent.sessions.get("s")).rejects.toMatchObject({ code: "unavailable", retryable: true });
    const streamed = agent.messages.stream({ sessionId: "s", content: "hi" })[Symbol.asyncIterator]();
    await expect(streamed.next()).rejects.toMatchObject({
      code: "unconfirmed",
      details: { sessionId: "s", idempotencyKey: expect.any(String) },
    });
  });

  it("ends a stream whose connection ends early with stream_error, never a rejection", async () => {
    const server = await fakeServer(
      () =>
        new Response(
          'event: state\ndata: {"type":"state","session":{"id":"s","status":"idle","usage":{"models":{},"tools":{}}}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    try {
      const events = connectAgent(server.url, { apiKey: KEY }).sessions.events("s")[Symbol.asyncIterator]();
      expect((await events.next()).value).toMatchObject({ type: "state" });
      expect((await events.next()).value).toMatchObject({
        type: "stream_error",
        error: { code: "unavailable", retryable: true },
      });
      expect((await events.next()).done).toBe(true);
    } finally {
      await server.close();
    }
  });
});
