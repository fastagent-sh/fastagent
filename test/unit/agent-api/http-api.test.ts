import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { OpenApi } from "effect/http-api";
import { TestClock } from "effect/testing";
import {
  type Agent,
  AgentErrorData,
  ConversationId,
  type DecodedMessageKey,
  Entry,
  type ErrorCode,
  IdempotencyKey,
  InvokeRequest,
  Message,
  MessageId,
  MessageKey,
  MessageStreamEvent,
  SendRequest,
  Session,
  SessionEvent,
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
  sqliteConversationStoreEffect,
} from "../../../packages/fastagent/src/conversations.ts";
import { connectAgent } from "@fastagent-sh/client";
import { connectAuth } from "@fastagent-sh/client/auth";
import {
  AgentHttpApi,
  MessageStreamEventFrame,
  Refusal,
  SessionEventFrame,
  statusOf,
} from "../../../packages/client/src/http/contract.ts";
import { sseEventStream } from "../../../packages/fastagent/src/http/server.ts";
import { abortThenJoin } from "../../../packages/fastagent/src/promise-bridge.ts";
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

    it("honors AbortSignal in createInvoker and maps transient PG failures to unavailable", async () => {
      const convKey = (name: string) => conversationStorageKey("", ConversationId.make(name));
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

describe("deterministic Effect TestClock & Schema Arbitrary invariants", () => {
  it.effect(
    "expires and bounds ephemeral idempotency bindings without evicting named conversations via TestClock",
    () =>
      Effect.gen(function* () {
        const convKey = (name: string) => conversationStorageKey("", ConversationId.make(name));
        const idemKey = (key: string) => idempotencyStorageKey("", IdempotencyKey.make(key));
        const sid = (id: string) => SessionId.make(id);

        const mem = memoryConversationStoreEffect({ ephemeralTtlMs: 100, maxEphemeral: 2 });
        yield* mem.set(convKey("ops"), sid("s-ops"), { ephemeral: false });
        yield* mem.set(idemKey("1"), sid("s-1"), { ephemeral: true });
        yield* mem.set(idemKey("2"), sid("s-2"), { ephemeral: true });
        yield* mem.set(idemKey("3"), sid("s-3"), { ephemeral: true });
        expect(yield* mem.get(idemKey("1"))).toBeUndefined();
        expect(yield* mem.get(idemKey("2"))).toBe("s-2");
        expect(yield* mem.get(idemKey("3"))).toBe("s-3");
        expect(yield* mem.get(convKey("ops"))).toBe("s-ops");
        yield* TestClock.adjust("200 millis");
        expect(yield* mem.get(idemKey("2"))).toBeUndefined();
        expect(yield* mem.get(idemKey("3"))).toBeUndefined();
        expect(yield* mem.get(convKey("ops"))).toBe("s-ops");

        const dir = yield* Effect.acquireRelease(
          Effect.sync(() => mkdtempSync(join(tmpdir(), "fa-conv-ttl-"))),
          (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
        );
        const sql = yield* Effect.acquireRelease(
          Effect.sync(() => sqliteConversationStoreEffect(join(dir, "conversations.sqlite"), { ephemeralTtlMs: 100 })),
          (store) => Effect.ignore(store.close),
        );
        yield* sql.set(convKey("ops"), sid("s-ops"), { ephemeral: false });
        yield* sql.set(idemKey("old"), sid("s-old"), { ephemeral: true });
        yield* TestClock.adjust("200 millis");
        yield* sql.set(idemKey("new"), sid("s-new"), { ephemeral: true });
        expect(yield* sql.get(idemKey("old"))).toBeUndefined();
        expect(yield* sql.get(idemKey("new"))).toBe("s-new");
        expect(yield* sql.get(convKey("ops"))).toBe("s-ops");
      }),
  );

  it.effect("emits SSE keep-alive comments on virtual time and closes cleanly with stream_error on shutdown", () => {
    const closing = new AbortController();
    return Effect.gen(function* () {
      const events = yield* Queue.unbounded<SessionEvent>();
      const chunks = yield* Ref.make<string[]>([]);
      const stream = sseEventStream("sessions.events", SessionEventFrame, Stream.fromQueue(events), {
        keepAliveMs: 20_000,
        closing: closing.signal,
      });
      const fiber = yield* Effect.forkChild(
        Stream.runForEach(stream, (chunk) => Ref.update(chunks, (list) => [...list, chunk])),
      );
      yield* Queue.offer(events, { type: "delta", channel: "text", text: "hi" });
      yield* TestClock.adjust("20 seconds");
      yield* TestClock.adjust("20 seconds");
      closing.abort();
      yield* Fiber.join(fiber);
      const collected = yield* Ref.get(chunks);
      expect(collected.some((c) => c.includes("event: delta") && c.includes('"text":"hi"'))).toBe(true);
      expect(collected.filter((c) => c === ": open\n\n").length).toBeGreaterThanOrEqual(2);
      expect(collected.at(-1)).toContain("event: stream_error");
      expect(collected.at(-1)).toContain("the service is closing");
    });
  });

  it.effect(
    "interrupts abortThenJoin on TestClock timeout and joins settlement before releasing scoped resources",
    () =>
      Effect.gen(function* () {
        const order: string[] = [];
        const pending = Promise.withResolvers<string>();
        const work = Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.acquireRelease(Effect.void, () => Effect.sync(() => void order.push("released")));
            return yield* abortThenJoin(
              "test-op",
              () => pending.promise,
              () => {
                order.push("aborted");
              },
            );
          }),
        );
        const fiber = yield* Effect.forkChild(work.pipe(Effect.timeoutOption("100 millis")));
        yield* TestClock.adjust("100 millis");
        expect(order).toEqual(["aborted"]);
        pending.resolve("late");
        expect((yield* Fiber.join(fiber))._tag).toBe("None");
        expect(order).toEqual(["aborted", "released"]);
      }),
  );

  it.prop(
    "round-trips Agent API domain schemas through JSON without loss",
    [SendRequest, InvokeRequest, MessageKey, AgentErrorData, Session, Message, Entry],
    ([sendReq, invokeReq, msgKey, errData, session, message, entry]) => {
      const check = <A, E>(schema: Schema.Codec<A, E>, value: A) => {
        const json = Schema.fromJsonString(schema);
        const encoded = Schema.encodeSync(json)(value);
        const decoded = Schema.decodeSync(json)(encoded);
        expect(Schema.encodeSync(json)(decoded)).toBe(encoded);
      };
      check(SendRequest, sendReq);
      check(InvokeRequest, invokeReq);
      check(MessageKey, msgKey);
      check(AgentErrorData, errData);
      check(Session, session);
      check(Message, message);
      check(Entry, entry);
    },
    { arbitrary: { runs: 25 } },
  );

  it.prop(
    "round-trips SessionEventFrame, MessageStreamEventFrame, and Refusal codecs and maps every error to a valid HTTP status",
    [SessionEvent, MessageStreamEvent, AgentErrorData],
    ([sessionEvent, messageEvent, errData]) => {
      const sessionFrame = Schema.encodeSync(SessionEventFrame)(sessionEvent);
      const decodedSession = Schema.decodeSync(SessionEventFrame)(sessionFrame);
      expect(decodedSession.type).toBe(sessionEvent.type);
      if (sessionEvent.type === "entry") expect(sessionFrame.id).toBe(sessionEvent.entry.id);

      const msgFrame = Schema.encodeSync(MessageStreamEventFrame)(messageEvent);
      const decodedMsg = Schema.decodeSync(MessageStreamEventFrame)(msgFrame);
      expect(decodedMsg.type).toBe(messageEvent.type);

      const refusal = Schema.decodeSync(Refusal)({ error: errData });
      expect(Schema.encodeSync(Refusal)(refusal).error).toEqual(errData);
      expect([400, 401, 404, 409, 413, 429, 500, 503]).toContain(statusOf(errData));
    },
    { arbitrary: { runs: 25 } },
  );

  it.effect.prop(
    "preserves named conversation bindings across TTL expiry while expiring ephemeral idempotency bindings",
    [ConversationId, IdempotencyKey, SessionId, SessionId],
    ([conversation, idempotency, durableSession, ephemeralSession]) =>
      Effect.gen(function* () {
        const store = memoryConversationStoreEffect({ ephemeralTtlMs: 60_000, maxEphemeral: 4 });
        const namedKey = conversationStorageKey("", conversation);
        const ephKey = idempotencyStorageKey("", idempotency);
        yield* store.set(namedKey, durableSession, { ephemeral: false });
        yield* store.set(ephKey, ephemeralSession, { ephemeral: true });
        expect(yield* store.get(namedKey)).toBe(durableSession);
        expect(yield* store.get(ephKey)).toBe(ephemeralSession);
        yield* TestClock.adjust("60 seconds");
        expect(yield* store.get(ephKey)).toBeUndefined();
        expect(yield* store.get(namedKey)).toBe(durableSession);
      }),
    { arbitrary: { runs: 25 } },
  );
});
