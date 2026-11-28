import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SESSION_HEADER, agentCoreHandler } from "@fastagent-sh/agentcore";
import { AgentError as RootAgentError } from "@fastagent-sh/client";
import { AgentError, connectAgentCore } from "@fastagent-sh/client-agentcore";
import { connectAgentCoreAuth } from "@fastagent-sh/client-agentcore/auth";
import { envelopeResponse } from "../../../packages/agentcore/src/contract.ts";
import { unwrapResponse } from "../../../packages/client-agentcore/src/contract.ts";
import { loadSourceDefinition } from "../../../packages/fastagent/src/harnesses/assembly.ts";
import { type PostgresDatabase, openPgDatabase } from "../../../packages/fastagent/src/postgres.ts";
import { fauxAgent } from "../../doubles/cli-run.ts";
import { type ServedPostgres, freshInstance, servedPostgres } from "../../doubles/postgres-double.ts";
import { RUNTIME, answered, installFakeAgentCore, invocation } from "./agentcore-fixture.ts";

let postgres: ServedPostgres;
beforeAll(async () => {
  postgres = await servedPostgres();
});
afterAll(() => postgres.close());

async function runtimeOf(
  prefix: string,
  database: PostgresDatabase | (() => PostgresDatabase) = { url: postgres.url },
) {
  const dir = await fauxAgent(prefix);
  const handler = agentCoreHandler(await loadSourceDefinition(dir), {
    database,
    root: dir,
    secrets: process.env,
  });
  return { dir, handler };
}

const agentCore = installFakeAgentCore();

describe("@fastagent-sh/agentcore & @fastagent-sh/client-agentcore", () => {
  it("serves the Agent API & Auth API over signed AgentCore invocations backed by PostgreSQL", async () => {
    const { dir, handler } = await runtimeOf("fa-agentcore-runtime-");
    const aws = agentCore(handler);
    const sessionId = freshInstance();
    try {
      const agent = connectAgentCore({ runtimeArn: RUNTIME, sessionId });
      expect((await agent.info()).name).toBe(sessionId);
      const auth = connectAgentCoreAuth({ runtimeArn: RUNTIME, sessionId });
      expect(Array.isArray(await auth.providers())).toBe(true);

      const { id } = await agent.sessions.create();
      const sent = await agent.messages.send({ sessionId: id, content: "hello" }, { wait: 30 });
      expect([sent.status, sent.answer?.text]).toEqual(["completed", "seen 1"]);

      const stream = agent.messages.stream({ sessionId: id, content: "linger" })[Symbol.asyncIterator]();
      const first = await stream.next();
      expect(first.value).toMatchObject({
        type: "message",
        message: { status: expect.stringMatching(/queued|running/) },
      });
      let last = first;
      for (let next = await stream.next(); !next.done; next = await stream.next()) last = next;
      expect(last.value).toMatchObject({ type: "done" });

      expect(AgentError).toBe(RootAgentError);
      const missing = await agent.sessions.get("no-such-session").catch((e: unknown) => e);
      expect(missing).toBeInstanceOf(AgentError);
      expect(missing).toMatchObject({ code: "not_found" });

      const binary = new Uint8Array(70_000);
      for (let i = 0; i < binary.length; i += 1) binary[i] = i & 0xff;
      const unwrappedBinary = unwrapResponse(
        await envelopeResponse(new Response(binary, { status: 200, headers: { "content-type": "image/png" } })),
      );
      expect(new Uint8Array(await unwrappedBinary.arrayBuffer())).toEqual(binary);
      expect(unwrapResponse(await envelopeResponse(new Response(null, { status: 204 }))).status).toBe(204);
      expect(existsSync(join(dir, ".state", "agent.sqlite"))).toBe(false);
      expect(
        aws.signatures.every((signature) => signature.includes("/ap-southeast-1/bedrock-agentcore/aws4_request")),
      ).toBe(true);

      expect(aws.urls.every((url) => !url.includes("qualifier="))).toBe(true);
      const released = connectAgentCore({ runtimeArn: RUNTIME, sessionId, qualifier: "prod" });
      expect((await released.info()).name).toBe(sessionId);
      expect(aws.urls.at(-1)).toContain("qualifier=prod");
    } finally {
      await aws.close();
      await handler.close();
    }
  });

  it("runs harness: dsh on AgentCore and persists sessions and attachments across MicroVM recycles", async () => {
    const dir = await fauxAgent("fa-agentcore-dsh-");
    const definition = await loadSourceDefinition(dir);
    const sessionId = freshInstance();
    const handler1 = agentCoreHandler(definition, {
      database: { url: postgres.url },
      root: dir,
      secrets: process.env,
      harness: "dsh",
      sandbox: "off",
    });
    const aws1 = agentCore(handler1);
    let createdSessionId!: string;
    try {
      const agent = connectAgentCore({ runtimeArn: RUNTIME, sessionId });
      expect((await agent.info()).name).toBe(sessionId);
      const created = await agent.sessions.create({ title: "DSH on AgentCore" });
      createdSessionId = created.id;
      const sent = await agent.messages.send(
        {
          sessionId: createdSessionId,
          idempotencyKey: "ac-dsh-idem-1",
          content: [
            { type: "text", text: "hello dsh" },
            { type: "image", mimeType: "image/png", data: Buffer.alloc(600, 0x42).toString("base64") },
          ],
        },
        { wait: 30 },
      );
      expect([sent.status, sent.answer?.text]).toEqual(["completed", "seen 1"]);
      expect((await agent.messages.get({ sessionId: createdSessionId, idempotencyKey: "ac-dsh-idem-1" })).id).toBe(
        sent.id,
      );
    } finally {
      await aws1.close();
      await handler1.close();
    }

    const handler2 = agentCoreHandler(definition, {
      database: { url: postgres.url },
      root: dir,
      secrets: process.env,
      harness: "dsh",
      sandbox: "off",
    });
    const aws2 = agentCore(handler2);
    try {
      const agent = connectAgentCore({ runtimeArn: RUNTIME, sessionId });
      expect((await agent.sessions.get(createdSessionId)).title).toBe("DSH on AgentCore");
      const entries = await agent.sessions.entries(createdSessionId);
      expect(entries.data.length).toBeGreaterThanOrEqual(2);
      const userData = entries.data[0]?.data as { content: Array<{ type: string; ref?: string }> };
      const imgRef = userData.content[1]?.ref as string;
      const att = await agent.sessions.attachment(createdSessionId, imgRef);
      expect(att.mimeType).toBe("image/png");
      expect(att.data.length).toBe(600);
    } finally {
      await aws2.close();
      await handler2.close();
    }
  });

  it("refuses wrong-session, missing-header, and malformed invocations, and reports HealthyBusy on /ping", async () => {
    const { handler } = await runtimeOf("fa-agentcore-busy-");
    const aws = agentCore(handler);
    const session = freshInstance();
    const request = { request: { method: "GET", path: "/v1/agent", headers: {} } };
    const ping = async () =>
      ((await (await handler.fetch(new Request("http://runtime/ping"))).json()) as { status: string }).status;
    try {
      expect(await ping()).toBe("Healthy");
      expect((await answered(await handler.fetch(invocation(session, request)))).status).toBe(200);
      const other = await answered(await handler.fetch(invocation("another-session-0123456789abcdef0123", request)));
      expect([other.status, other.body.error.message]).toEqual([
        400,
        `this AgentCore session is the instance "${session}", not "another-session-0123456789abcdef0123"`,
      ]);
      const unnamed = await answered(await handler.fetch(invocation(undefined, request)));
      expect(unnamed.body.error.message).toBe(`an invocation names its AgentCore session in ${SESSION_HEADER}`);
      const bare = await answered(await handler.fetch(invocation(session, { prompt: "hi" })));
      expect(bare.body.error.message).toBe("an invocation is { request: { method, path, headers, body } }");

      const agent = connectAgentCore({ runtimeArn: RUNTIME, sessionId: session });
      const { id: sessionId } = await agent.sessions.create();
      const message = await agent.messages.send({ sessionId, content: "linger" });
      await vi.waitFor(async () => expect(await ping()).toBe("HealthyBusy"), { timeout: 3_000 });
      await agent.messages.get({ sessionId, messageId: message.id }, { wait: 15 });
      await vi.waitFor(async () => expect(await ping()).toBe("Healthy"), { timeout: 3_000 });
    } finally {
      await aws.close();
      await handler.close();
    }
  });

  it("loads dynamic values(), classifies transient DB failures as 503 unavailable, reopens on lease takeover, and handles close races", async () => {
    const dir = await fauxAgent("fa-agentcore-values-", {
      "src/tools/ticket.ts": [
        `import { defineTool, needs } from "@fastagent-sh/fastagent";`,
        `export default needs(["ZENDESK_TOKEN"], () => defineTool({ name: "ticket", description: "File a ticket.", parameters: { type: "object", properties: {} } as const, execute: async () => "ok" }));`,
      ].join("\n"),
    });
    let reads = 0;
    const handler = agentCoreHandler(await loadSourceDefinition(dir), {
      database: { url: postgres.url },
      root: dir,
      secrets: process.env,
      values: async () => {
        reads += 1;
        if (reads === 1) throw new Error("secret not created yet");
        return { ZENDESK_TOKEN: "zd" };
      },
    });
    const { handler: unreached } = await runtimeOf("fa-agentcore-unreached-", {
      url: "postgres://postgres@127.0.0.1:1/postgres",
    });
    const session = freshInstance();
    const request = { request: { method: "GET", path: "/v1/agent", headers: {} } };
    try {
      const unread = await answered(await handler.fetch(invocation(session, request)));
      expect([unread.status, unread.body.error.code]).toEqual([500, "internal"]);
      expect(unread.body.error.message).toContain("secret not created yet");
      expect([(await answered(await handler.fetch(invocation(session, request)))).status, reads]).toEqual([200, 2]);

      const passing = await answered(await unreached.fetch(invocation(freshInstance(), request)));
      expect([passing.status, passing.headers["retry-after"], passing.body.error.code]).toEqual([
        503,
        "1",
        "unavailable",
      ]);
    } finally {
      await handler.close();
      await unreached.close();
    }

    // Lease takeover triggers clean reopen on next invocation.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { handler: leaseHandler } = await runtimeOf("fa-agentcore-taken-");
    const db = openPgDatabase(postgres.url);
    const leaseSession = freshInstance();
    const create = {
      request: { method: "POST", path: "/v1/sessions", headers: { "content-type": "application/json" }, body: "{}" },
    };
    try {
      expect((await answered(await leaseHandler.fetch(invocation(leaseSession, create)))).status).toBe(201);
      await db.query(
        "UPDATE durable_leases SET owner = 'another', lease_until = now() - interval '1 second' WHERE instance = $1",
        [leaseSession],
      );
      vi.advanceTimersByTime(10_000);
      await vi.waitFor(
        async () =>
          expect((await answered(await leaseHandler.fetch(invocation(leaseSession, create)))).status).toBe(201),
        { timeout: 10_000, interval: 200 },
      );
    } finally {
      vi.useRealTimers();
      await db.close();
      await leaseHandler.close();
    }

    // AWS SigV4 refusals and close() race safety.
    const { handler: refHandler } = await runtimeOf("fa-agentcore-refused-");
    const aws = agentCore(refHandler);
    try {
      const agent = connectAgentCore({ runtimeArn: RUNTIME, sessionId: freshInstance() });
      aws.refuse(403, "AccessDeniedException");
      await expect(agent.info()).rejects.toMatchObject({ code: "unauthorized" });
      aws.refuse(404, "ResourceNotFoundException");
      await expect(agent.info()).rejects.toMatchObject({ code: "internal", retryable: false });
      expect(() => connectAgentCore({ runtimeArn: RUNTIME, sessionId: "user-42" })).toThrow(/33 to 256/);
      expect(() => connectAgentCore({ runtimeArn: "support", sessionId: freshInstance() })).toThrow(/not an AgentCore/);
    } finally {
      await aws.close();
      await refHandler.close();
    }

    const gate = Promise.withResolvers<Record<string, string>>();
    const started = Promise.withResolvers<void>();
    const raceDir = await fauxAgent("fa-agentcore-close-race-");
    const raceHandler = agentCoreHandler(await loadSourceDefinition(raceDir), {
      database: { url: postgres.url },
      root: raceDir,
      secrets: process.env,
      values: () => {
        started.resolve();
        return gate.promise;
      },
    });
    const inFlight = raceHandler.fetch(invocation(freshInstance(), request));
    await started.promise;
    const closePromise = raceHandler.close();
    const late = await answered(await raceHandler.fetch(invocation(freshInstance(), request)));
    expect([late.status, late.body.error.code]).toEqual([503, "unavailable"]);
    gate.resolve({});
    await closePromise;
    await inFlight.catch(() => undefined);
  });
});
