import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type Agent,
  type AgentErrorData,
  ConversationId,
  type DecodedMessageKey,
  type ErrorCode,
  IdempotencyKey,
  MessageId,
  MessageKey,
  SessionId,
  decodeRequest,
} from "../../../packages/client/src/agent-api.ts";
import {
  type ConversationKey,
  conversationStorageKey,
  createInvoker,
  idempotencyStorageKey,
  memoryConversationStore,
  memoryConversationStoreEffect,
  postgresConversationStore,
  sqliteConversationStore,
  sqliteConversationStoreEffect,
} from "../../../packages/fastagent/src/conversations.ts";
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

    it("expires and bounds ephemeral idempotency bindings without evicting named conversations, honors AbortSignal, and maps transient PG failures to unavailable", async () => {
      const convKey = (name: string) => conversationStorageKey("", ConversationId.make(name));
      const idemKey = (key: string) => idempotencyStorageKey("", IdempotencyKey.make(key));
      const sid = (id: string) => SessionId.make(id);

      let nowMs = 1_000;
      const clock: Clock.Clock = {
        currentTimeMillisUnsafe: () => nowMs,
        currentTimeMillis: Effect.sync(() => nowMs),
        monotonicTimeNanosUnsafe: () => BigInt(nowMs) * 1_000_000n,
        monotonicTimeNanos: Effect.sync(() => BigInt(nowMs) * 1_000_000n),
        currentTimeNanosUnsafe: () => BigInt(nowMs) * 1_000_000n,
        currentTimeNanos: Effect.sync(() => BigInt(nowMs) * 1_000_000n),
        sleep: () => Effect.void,
      };
      const mem = memoryConversationStore({ ephemeralTtlMs: 100, maxEphemeral: 2, clock });
      await mem.set(convKey("ops"), sid("s-ops"), { ephemeral: false });
      await mem.set(idemKey("1"), sid("s-1"), { ephemeral: true });
      await mem.set(idemKey("2"), sid("s-2"), { ephemeral: true });
      await mem.set(idemKey("3"), sid("s-3"), { ephemeral: true });
      expect(await mem.get(idemKey("1"))).toBeUndefined();
      expect(await mem.get(idemKey("2"))).toBe("s-2");
      expect(await mem.get(idemKey("3"))).toBe("s-3");
      expect(await mem.get(convKey("ops"))).toBe("s-ops");
      nowMs += 200;
      expect(await mem.get(idemKey("2"))).toBeUndefined();
      expect(await mem.get(idemKey("3"))).toBeUndefined();
      expect(await mem.get(convKey("ops"))).toBe("s-ops");

      const effectStore = memoryConversationStoreEffect({ ephemeralTtlMs: 100 });
      const effectOutcome = await Effect.runPromise(
        Effect.gen(function* () {
          yield* effectStore.set(idemKey("eff"), sid("s-eff"), { ephemeral: true });
          const before = yield* effectStore.get(idemKey("eff"));
          nowMs += 200;
          const after = yield* effectStore.get(idemKey("eff"));
          return { before, after };
        }).pipe(Effect.provideService(Clock.Clock, clock)),
      );
      expect(effectOutcome).toEqual({ before: "s-eff", after: undefined });

      const dir = mkdtempSync(join(tmpdir(), "fa-conv-ttl-"));
      try {
        const sql = sqliteConversationStore(join(dir, "conversations.sqlite"), {
          ephemeralTtlMs: 100,
          clock,
        });
        await sql.set(convKey("ops"), sid("s-ops"), { ephemeral: false });
        await sql.set(idemKey("old"), sid("s-old"), { ephemeral: true });
        nowMs += 200;
        await sql.set(idemKey("new"), sid("s-new"), { ephemeral: true });
        expect(await sql.get(idemKey("old"))).toBeUndefined();
        expect(await sql.get(idemKey("new"))).toBe("s-new");
        expect(await sql.get(convKey("ops"))).toBe("s-ops");
        await sql.close();

        const sqlEff = sqliteConversationStoreEffect(join(dir, "conversations-eff.sqlite"), { ephemeralTtlMs: 100 });
        const sqlEffOutcome = await Effect.runPromise(
          Effect.gen(function* () {
            yield* sqlEff.set(idemKey("eff-sql"), sid("s-eff-sql"), { ephemeral: true });
            const before = yield* sqlEff.get(idemKey("eff-sql"));
            nowMs += 200;
            const after = yield* sqlEff.get(idemKey("eff-sql"));
            yield* sqlEff.close();
            return { before, after };
          }).pipe(Effect.provideService(Clock.Clock, clock)),
        );
        expect(sqlEffOutcome).toEqual({ before: "s-eff-sql", after: undefined });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }

      const invoker = createInvoker(agent, memoryConversationStore());
      const beforeCount = (await agent.sessions.list()).data.length;
      const aborted = new AbortController();
      aborted.abort(new Error("caller left"));
      await expect(
        invoker.invoke({ conversation: "never", content: "hi" }, { signal: aborted.signal }),
      ).rejects.toThrow("caller left");
      const streamIter = invoker
        .invokeStream({ conversation: "never", content: "hi" }, { signal: aborted.signal })
        [Symbol.asyncIterator]();
      await expect(streamIter.next()).rejects.toThrow("caller left");
      expect((await agent.sessions.list()).data.length).toBe(beforeCount);

      const brokenPg = postgresConversationStore({ url: "postgres://127.0.0.1:1/unreachable" }, "inst-1");
      await expect(brokenPg.get(convKey("ops"))).rejects.toMatchObject({ code: "unavailable", retryable: true });
      await brokenPg.close();
    });

    it("keeps SessionId, ConversationId, ConversationKey, MessageId, and IdempotencyKey nominally distinct", () => {
      const sessionId = SessionId.make("sess_1");
      const conversationId = ConversationId.make("slack:C123");
      const conversationKey = conversationStorageKey("", conversationId);
      const messageId = MessageId.make("msg_1");
      const idempotencyKey = IdempotencyKey.make("idem_1");

      const decodedById: DecodedMessageKey = decodeRequest(MessageKey, { sessionId, messageId }, "test");
      const decodedByKey: DecodedMessageKey = decodeRequest(MessageKey, { sessionId, idempotencyKey }, "test");
      expect(decodedById).toEqual({ sessionId: "sess_1", messageId: "msg_1" });
      expect(decodedByKey).toEqual({ sessionId: "sess_1", idempotencyKey: "idem_1" });

      const acceptSession = (id: SessionId) => id;
      const acceptConversation = (id: ConversationId) => id;
      const acceptStoreKey = (key: ConversationKey) => key;
      const acceptMessage = (id: MessageId) => id;

      expect(acceptSession(sessionId)).toBe("sess_1");
      expect(acceptConversation(conversationId)).toBe("slack:C123");
      expect(acceptStoreKey(conversationKey)).toBe("c:slack:C123");
      expect(acceptMessage(messageId)).toBe("msg_1");

      // Compile-time nominal separation checks: mixing domain IDs must fail typecheck.
      // @ts-expect-error ConversationId cannot be passed where SessionId is expected
      void (() => acceptSession(conversationId));
      // @ts-expect-error SessionId cannot be passed where ConversationId is expected
      void (() => acceptConversation(sessionId));
      // @ts-expect-error SessionId cannot be used as a ConversationStore key
      void (() => acceptStoreKey(sessionId));
      // @ts-expect-error SessionId cannot be passed where MessageId is expected
      void (() => acceptMessage(sessionId));
      // @ts-expect-error MessageId cannot be passed where SessionId is expected
      void (() => acceptSession(messageId));
    });

    it("refuses non-string sessionId with AgentError invalid_request and defers stream refusal to first read", async () => {
      const client = connectAgent(server.url, { apiKey: KEY });
      await expect(client.sessions.get(null as unknown as string)).rejects.toMatchObject({
        code: "invalid_request",
      });
      const stream = client.sessions.events(123 as unknown as string);
      await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({
        code: "invalid_request",
      });
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
