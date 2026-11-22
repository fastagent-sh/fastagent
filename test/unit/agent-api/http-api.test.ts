import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentErrorData, ErrorCode } from "../../../packages/client/src/agent-api.ts";
import { connectAgent, connectAuth } from "../../../packages/client/src/http/client.ts";
import { OpenApi } from "effect/http-api";
import { AgentHttpApi, statusOf } from "../../../packages/client/src/http/contract.ts";
import { agentApiConformance } from "../../harnesses/agent-api-conformance.ts";
import { durableSubject } from "../../harnesses/durable-subject.ts";
import { KEY, type Served, httpSubject, served } from "../../harnesses/http-subject.ts";

agentApiConformance("pi-durable, over HTTP", httpSubject(durableSubject()));

const auth = (key = KEY) => ({ authorization: `Bearer ${key}`, "content-type": "application/json" });

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
    // A base URL given with the slash it may end with reaches the same routes.
    expect(await connectAgent(`${server.url}/`, { apiKey: KEY }).info()).toMatchObject({ name: "subject" });
    expect((await fetch(`${server.url}/v1/openapi.json`)).status).toBe(401);
    const document = (await (await fetch(`${server.url}/v1/openapi.json`, { headers: auth() })).json()) as {
      openapi: string;
      paths: Record<string, unknown>;
    };
    expect(document.openapi).toBe("3.1.0");
    expect(Object.keys(document.paths).sort()).toEqual([
      "/v1/agent",
      "/v1/auth/login",
      "/v1/auth/login/{flowId}",
      "/v1/auth/login/{flowId}/input",
      "/v1/auth/providers",
      "/v1/auth/providers/{provider}",
      "/v1/invoke",
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

  it("answers auth endpoints with empty providers and not_found when served without an auth manager", async () => {
    const authClient = connectAuth(server.url, { apiKey: KEY });
    expect(await authClient.providers()).toEqual([]);
    await expect(authClient.startLogin({ provider: "openai", method: "api_key" })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(authClient.getLogin("missing")).rejects.toMatchObject({ code: "not_found" });
    await expect(authClient.submitInput("missing", { promptId: "p1", value: "v" })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(authClient.cancelLogin("missing")).rejects.toMatchObject({ code: "not_found" });
    await expect(authClient.logout("openai")).rejects.toMatchObject({ code: "not_found" });
  });

  describe("POST /v1/invoke", () => {
    it("creates an ephemeral session, deduplicates retries by Idempotency-Key without creating a second session, and streams SSE", async () => {
      const client = connectAgent(server.url, { apiKey: KEY });

      const first = await client.invoke({ content: "hello", idempotencyKey: "ephemeral-1" }, { wait: 30 });
      expect(first).toMatchObject({ status: "completed", answer: { text: "answer: hello" } });

      // Retrying with the same idempotency key returns the exact same message and creates no second session.
      const retried = await client.invoke({ content: "hello", idempotencyKey: "ephemeral-1" }, { wait: 30 });
      expect(retried).toEqual(first);
      expect((await client.sessions.list()).data).toHaveLength(1);

      // Streaming invoke delivers message -> events -> done over SSE in a single HTTP request.
      const events: string[] = [];
      let streamedSessionId: string | undefined;
      for await (const event of client.invokeStream({ content: "streamed" })) {
        events.push(event.type);
        if (event.type === "message") streamedSessionId = event.message.sessionId;
      }
      expect(streamedSessionId).toBeDefined();
      expect(streamedSessionId).not.toBe(first.sessionId);
      expect(events[0]).toBe("message");
      expect(events.at(-1)).toBe("done");
    });

    it("resolves named conversations across calls, serializes concurrent first calls, self-heals after delete, and honors whenBusy", async () => {
      const client = connectAgent(server.url, { apiKey: KEY });

      // Concurrent first invokes on the same new conversation create exactly one session titled with its name.
      const [a, b] = await Promise.all([
        client.invoke({ conversation: "daily-digest", content: "first" }, { wait: 30 }),
        client.invoke({ conversation: "daily-digest", content: "second" }, { wait: 30 }),
      ]);
      expect(a.sessionId).toBe(b.sessionId);
      expect((await client.sessions.get(a.sessionId)).title).toBe("daily-digest");
      expect((await client.sessions.list()).data).toHaveLength(1);

      // Deleting the underlying session causes the next invoke to self-heal with a fresh session.
      await client.sessions.delete(a.sessionId);
      const healed = await client.invoke({ conversation: "daily-digest", content: "after delete" }, { wait: 30 });
      expect(healed.sessionId).not.toBe(a.sessionId);
      expect(healed.answer?.text).toBe("answer: after delete");

      // Busy conversation refuses concurrent invoke when whenBusy: "reject".
      const holding = await client.invoke({ conversation: "daily-digest", content: "hold" });
      await vi.waitFor(() => expect(subject.held()).toBe(1));
      await expect(
        client.invoke({ conversation: "daily-digest", content: "overlap", whenBusy: "reject" }),
      ).rejects.toMatchObject({ code: "busy" });
      subject.release();
      await client.messages.get({ sessionId: holding.sessionId, messageId: holding.id }, { wait: 30 });
    });

    it("enforces strict 404 on explicit sessionId and refuses invalid invoke requests with 400", async () => {
      const client = connectAgent(server.url, { apiKey: KEY });
      const created = await client.sessions.create();

      const ok = await client.invoke({ sessionId: created.id, content: "ping" }, { wait: 30 });
      expect(ok).toMatchObject({ sessionId: created.id, status: "completed", answer: { text: "answer: ping" } });

      await expect(client.invoke({ sessionId: "no-such-session", content: "hi" })).rejects.toMatchObject({
        code: "not_found",
      });

      // Mutually exclusive conversation + sessionId, blank conversation, and stream + wait are refused 400.
      const both = await fetch(`${server.url}/v1/invoke`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ conversation: "ops", sessionId: created.id, content: "hi" }),
      });
      expect(both.status).toBe(400);
      expect(await both.json()).toMatchObject({ error: { code: "invalid_request" } });

      const blank = await fetch(`${server.url}/v1/invoke`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ conversation: "   ", content: "hi" }),
      });
      expect(blank.status).toBe(400);

      const streamWait = await fetch(`${server.url}/v1/invoke`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ content: "hi", stream: true, wait: 10 }),
      });
      expect(streamWait.status).toBe(400);
      expect(await streamWait.json()).toMatchObject({ error: { code: "invalid_request" } });

      // invokeStream refuses invalid requests on first read.
      const badIter = client
        .invokeStream({ conversation: "ops", sessionId: created.id, content: "hi" })
        [Symbol.asyncIterator]();
      await expect(badIter.next()).rejects.toMatchObject({ code: "invalid_request" });
    });
  });
});

describe("refusals over HTTP", () => {
  afterEach(() => vi.restoreAllMocks());

  it("answers each code with its status", () => {
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
});
