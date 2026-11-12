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
