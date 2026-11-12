import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentErrorData, ErrorCode } from "../src/agent-api.ts";
import { connectAgent } from "../src/http/client.ts";
import { OpenApi } from "effect/http-api";
import { AgentHttpApi, statusOf } from "../src/http/contract.ts";
import { agentApiConformance } from "./agent-api-conformance.ts";
import { durableSubject } from "./durable-subject.ts";
import { KEY, type Served, httpSubject, served } from "./http-subject.ts";

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
      // The longest wait a request may name: uncapped, it would outlast the test's timeout.
      const capped = await fetch(`${server.url}/v1/sessions/${sessionId}/messages/${message.id}?wait=60`, {
        headers: auth(),
      });
      expect(await capped.json()).toMatchObject({ status: "running" });
      asked = 0;
      const started = Date.now();
      // A wait many caps long: past the first, it is asked again, however slowly each request comes back.
      const waited = await connectAgent(server.url, { apiKey: KEY }).messages.get(
        { sessionId, messageId: message.id },
        { wait: 1.5 },
      );
      expect(waited.status).toBe("running");
      expect(Date.now() - started).toBeGreaterThanOrEqual(1450);
      expect(asked).toBeGreaterThanOrEqual(2);
      subject.release();
    } finally {
      await server.close();
    }
  });
});
