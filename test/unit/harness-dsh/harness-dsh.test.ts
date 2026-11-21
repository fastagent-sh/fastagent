import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as EffectSchema from "effect/Schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defineTool } from "@fastagent-sh/fastagent";
import {
  DshInstanceHeldError,
  MemoryDshEventStore,
  buildDshSandboxPolicy,
  openDshAgent,
  openPostgresDshStore,
  openSqliteDshStore,
  toDshToolDefinition,
} from "@fastagent-sh/harness-dsh";
import { openPgDatabase } from "../../../packages/fastagent/src/harnesses/pi-durable/postgres/database.ts";
import { type ServedPostgres, freshInstance, servedPostgres } from "../../doubles/postgres-double.ts";
import { agentApiConformance } from "../../harnesses/agent-api-conformance.ts";
import { dshSubject } from "../../harnesses/dsh-subject.ts";

describe("@fastagent-sh/harness-dsh skeleton contracts", () => {
  it("MemoryDshEventStore enforces single-writer fencing, contiguous seqs, concurrent readers, and reopen", async () => {
    const store = new MemoryDshEventStore();
    const header = { version: 4, id: "s-1", createdAt: 1_700_000_000_000, isSeeded: false };
    const writer = await store.create(header);

    // Concurrent write open is refused; concurrent read open succeeds.
    await expect(store.open("s-1", "write")).rejects.toThrow(/already owned by another writer/);
    const reader = await store.open("s-1", "read");
    await expect(reader.append([{ seq: 0, type: "turn/start" }])).rejects.toThrow(/read-only/);

    // Non-contiguous seq is refused without partial mutation.
    await expect(writer.append([{ seq: 1, type: "turn/start" }])).rejects.toThrow(/expected contiguous seq 0/);
    await writer.append([
      { seq: 0, type: "turn/start", data: { turn: 1 } },
      { seq: 1, type: "turn/end", data: { turn: 1 } },
    ]);
    expect((await reader.read(0)).events.map((e) => e.type)).toEqual(["turn/start", "turn/end"]);
    expect(await store.stat("s-1")).toMatchObject({ eventCount: 2, revision: "2" });

    // Closing the writer releases ownership so a new writer can reopen.
    await writer.close();
    await expect(writer.read(0)).rejects.toThrow(/is closed/);
    const reopened = await store.open("s-1", "write");
    await reopened.append([{ seq: 2, type: "turn/start", data: { turn: 2 } }]);
    expect((await store.list())[0]?.eventCount).toBe(3);
    await reopened.close();
    await reader.close();
  });

  it("toDshToolDefinition bridges FastAgent defineTool (Standard JSON Schema v1) into DSH tool contract", async () => {
    const struct = EffectSchema.Struct({
      name: EffectSchema.String,
    });
    const schema = {
      ...EffectSchema.toStandardJSONSchemaV1(struct),
      "~standard": {
        ...EffectSchema.toStandardJSONSchemaV1(struct)["~standard"],
        ...EffectSchema.toStandardSchemaV1(struct)["~standard"],
      },
    };
    const fastAgentTool = defineTool({
      name: "greet",
      description: "Greet a person",
      parameters: schema,
      execute: async ({ name }) => `Hello, ${name}!`,
    });

    const bridged = toDshToolDefinition(fastAgentTool);
    expect(bridged.name).toBe("greet");
    expect(bridged.parameters).toMatchObject({ type: "object", required: ["name"] });

    const out = await bridged.execute({ name: "Ada" }, { signal: new AbortController().signal });
    expect(out).toEqual({ text: "Hello, Ada!" });
    expect(bridged.output.render({}, out)).toEqual([{ type: "text", text: "Hello, Ada!" }]);

    const bad = await bridged.execute({ name: 123 }, { signal: new AbortController().signal });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("Invalid arguments");
  });

  it("buildDshSandboxPolicy produces fail-closed policies for workspace, read-only, and off modes", () => {
    expect(buildDshSandboxPolicy({ workdir: "/srv/agent", mode: "off" })).toBeUndefined();
    expect(buildDshSandboxPolicy({ workdir: "/srv/agent" })).toEqual({
      workspace: "/srv/agent",
      writablePaths: ["/srv/agent"],
      readablePaths: ["/srv/agent"],
      network: "none",
    });
    expect(buildDshSandboxPolicy({ workdir: "/srv/agent", mode: "read-only", network: true })).toEqual({
      workspace: "/srv/agent",
      writablePaths: [],
      readablePaths: ["/srv/agent"],
      network: "allow",
    });
    expect(() => buildDshSandboxPolicy({ workdir: "relative/dir" })).toThrow(/must be an absolute path/);
  });

  it("openDshAgent validates options up front and boots a live Cordis agent", async () => {
    await expect(openDshAgent({ name: "", workdir: "/srv/agent" })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(openDshAgent({ name: "demo", workdir: "relative" })).rejects.toMatchObject({
      code: "invalid_request",
    });
    const agent = await openDshAgent({ name: "demo", workdir: "/srv/agent" });
    try {
      expect(await agent.info()).toMatchObject({ name: "demo", tools: [], models: [] });
    } finally {
      await agent.close();
    }
  });

  it("enforces empty tool allowlists (tools: []) and rejects pending waiters when a session is deleted", async () => {
    const { createFauxCore, createModels, createProvider, fauxAssistantMessage, fauxToolCall } = await import(
      "@earendil-works/pi-ai"
    );
    const core = createFauxCore({ provider: "p", api: "p" });
    let holdCalled = 0;
    let releaseHold: (() => void) | undefined;
    const stream = (...args: Parameters<typeof core.streamSimple>) => {
      const last = args[1].messages.at(-1);
      if (last?.role === "toolResult") {
        core.appendResponses([fauxAssistantMessage(last.isError ? "denied" : "ran")]);
      } else {
        core.appendResponses([fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" })]);
      }
      return core.streamSimple(...args);
    };
    const models = createModels();
    models.setProvider(
      createProvider({
        id: "p",
        auth: { apiKey: { name: "P", resolve: async () => ({ auth: {} }) } },
        models: core.models,
        api: { stream, streamSimple: stream },
      }),
    );
    const holdTool = defineTool({
      name: "hold",
      description: "blocks until released or aborted",
      parameters: { type: "object", properties: {} } as const,
      execute: (_args, _api, ctx) =>
        new Promise<string>((resolve, reject) => {
          holdCalled++;
          releaseHold = () => resolve("done");
          ctx.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    });
    const agent = await openDshAgent({
      name: "demo",
      workdir: "/srv/agent",
      models,
      model: { provider: "p", modelId: core.getModel().id },
      tools: [holdTool],
      sandbox: "off",
    });
    try {
      const noTools = await agent.sessions.create({ tools: [] });
      const denied = await agent.messages.send({ sessionId: noTools.id, content: "hold" }, { wait: 10 });
      expect(denied.answer?.text).toBe("denied");
      expect(holdCalled).toBe(0);

      const busy = await agent.sessions.create();
      const waiting = agent.messages.send({ sessionId: busy.id, content: "hold" }, { wait: 10 }).then(
        () => undefined,
        (error: unknown) => error,
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      await agent.sessions.delete(busy.id);
      expect(await waiting).toMatchObject({ code: "not_found" });
    } finally {
      releaseHold?.();
      await agent.close();
    }
  });

  it("openSqliteDshStore enforces contiguous seqs atomically and survives reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-sqlite-unit-"));
    const dbPath = join(dir, "dsh.sqlite");
    try {
      const store1 = openSqliteDshStore(dbPath);
      const header = { version: 4, id: "s-1", createdAt: 1_700_000_000_000, isSeeded: false };
      const writer = await store1.create(header);
      await expect(store1.open("s-1", "write")).rejects.toThrow(/already owned/);
      // Bad batch must roll back completely with zero partial rows written.
      await expect(
        writer.append([
          { seq: 0, type: "turn/start", data: { turn: 1 } },
          { seq: 2, type: "turn/end", data: { turn: 1 } },
        ]),
      ).rejects.toThrow(/expected contiguous seq 1/);
      expect((await writer.read(0)).events).toEqual([]);

      await writer.append([
        { seq: 0, type: "turn/start", data: { turn: 1 } },
        { seq: 1, type: "turn/end", data: { turn: 1 } },
      ]);
      await writer.close();
      await store1.close();

      const store2 = openSqliteDshStore(dbPath);
      expect(await store2.stat("s-1")).toMatchObject({ eventCount: 2, revision: "2" });
      const reader = await store2.open("s-1", "read");
      expect((await reader.read(0)).events.map((ev) => ev.type)).toEqual(["turn/start", "turn/end"]);
      await reader.close();
      await store2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("@fastagent-sh/harness-dsh PostgreSQL persistence", () => {
  let postgres: ServedPostgres;
  beforeAll(async () => {
    postgres = await servedPostgres();
  });
  afterAll(() => postgres.close());

  it("enforces dsh_leases single-writer fencing, multi-instance isolation, and full openDshAgent restart", async () => {
    const db = openPgDatabase(postgres.url);
    const instanceA = freshInstance();
    const instanceB = freshInstance();
    try {
      // Single-writer lease fencing: second live holder refused, close releases immediately, expired lease taken over.
      const held = await openPostgresDshStore(db, instanceA, { leaseMs: 120, owner: "holder-1" });
      await expect(openPostgresDshStore(db, instanceA, { leaseMs: 120, waitMs: 0, owner: "holder-2" })).rejects.toThrow(
        DshInstanceHeldError,
      );

      // Multi-instance isolation on the same database.
      const other = await openPostgresDshStore(db, instanceB, { leaseMs: 5_000, owner: "holder-b" });
      const hA = await held.create({ version: 4, id: "shared-id", createdAt: 1, isSeeded: false });
      const hB = await other.create({ version: 4, id: "shared-id", createdAt: 2, isSeeded: false });
      await hA.append([{ seq: 0, type: "turn/start", data: { turn: 1 } }]);
      expect((await hB.read(0)).events).toEqual([]);
      // Atomic contiguous seq rollback on PostgreSQL.
      await expect(
        hB.append([
          { seq: 0, type: "turn/start", data: { turn: 1 } },
          { seq: 5, type: "turn/end", data: { turn: 1 } },
        ]),
      ).rejects.toThrow(/expected contiguous seq 1/);
      expect((await hB.read(0)).events).toEqual([]);
      await hA.close();
      await hB.close();
      await other.close();
      await held.close();

      // Reopen on the same instance after close succeeds immediately and runs a full DSH agent + restart.
      const { createFauxCore, createModels, createProvider, fauxAssistantMessage } = await import(
        "@earendil-works/pi-ai"
      );
      const makeModels = () => {
        const core = createFauxCore({ provider: "pg", api: "pg" });
        const stream = (...args: Parameters<typeof core.streamSimple>) => {
          const last = args[1].messages.at(-1);
          const text =
            last?.role === "user"
              ? typeof last.content === "string"
                ? last.content
                : last.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("")
              : "";
          core.appendResponses([fauxAssistantMessage(`pg-reply: ${text}`)]);
          return core.streamSimple(...args);
        };
        const models = createModels();
        models.setProvider(
          createProvider({
            id: "pg",
            auth: { apiKey: { name: "PG", resolve: async () => ({ auth: {} }) } },
            models: core.models,
            api: { stream, streamSimple: stream },
          }),
        );
        return { models, model: { provider: "pg", modelId: core.getModel().id } };
      };

      const store1 = await openPostgresDshStore(db, freshInstance());
      const { models: m1, model } = makeModels();
      const agent1 = await openDshAgent({
        name: "pg-agent",
        workdir: "/srv/pg-agent",
        models: m1,
        model,
        sandbox: "off",
        storage: store1,
      });
      const session = await agent1.sessions.create({ title: "Postgres Session" });
      const sent = await agent1.messages.send(
        {
          sessionId: session.id,
          content: [
            { type: "text", text: "hello" },
            { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
          ],
          idempotencyKey: "k-pg-1",
          metadata: { channel: "pg" },
        },
        { wait: 10 },
      );
      expect(sent.status).toBe("completed");
      expect(sent.answer?.text).toBe("pg-reply: hello");
      const entries1 = await agent1.sessions.entries(session.id);
      const userData = entries1.data[0]?.data as { content: Array<{ type: string; ref?: string }> };
      const imgRef = userData.content[1]?.ref as string;
      const pgInstanceName = store1.instance;
      await agent1.close();
      await store1.close();

      // Reopen a fresh store + fresh DSH agent on the same Postgres instance.
      const store2 = await openPostgresDshStore(db, pgInstanceName);
      const { models: m2 } = makeModels();
      const agent2 = await openDshAgent({
        name: "pg-agent",
        workdir: "/srv/pg-agent",
        models: m2,
        model,
        sandbox: "off",
        storage: store2,
      });
      expect((await agent2.sessions.get(session.id)).title).toBe("Postgres Session");
      expect(await agent2.messages.get({ sessionId: session.id, idempotencyKey: "k-pg-1" })).toEqual(sent);
      const attachment = await agent2.sessions.attachment(session.id, imgRef);
      expect(attachment.mimeType).toBe("image/png");
      expect(Buffer.from(attachment.data).toString("base64")).toBe("iVBORw0KGgo=");
      await agent2.close();
      await store2.close();
    } finally {
      await db.close();
    }
  });
});

agentApiConformance("dsh (sqlite)", dshSubject());
