import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as EffectSchema from "effect/Schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defineTool } from "@fastagent-sh/fastagent";
import {
  DshInstanceHeldError,
  MemoryDshEventStore,
  openDshAgent,
  openDshAgentFromDir,
  openPostgresDshStore,
  openSqliteDshStore,
} from "@fastagent-sh/harness-dsh";
import { buildDshSandboxPolicy, resolveConfinedPath } from "../../../packages/harness-dsh/src/sandbox.ts";
import { bridgeDshRuntimeTool } from "../../../packages/harness-dsh/src/tools.ts";
import { openPgDatabase } from "../../../packages/fastagent/src/postgres.ts";
import { loadSourceDefinition } from "../../../packages/fastagent/src/harnesses/pi-durable/open.ts";
import { openAgent } from "../../../packages/fastagent/src/harnesses/serving.ts";
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

  it("bridgeDshRuntimeTool bridges FastAgent defineTool (Standard JSON Schema v1) into DSH tool contract", async () => {
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

    const bridged = bridgeDshRuntimeTool(fastAgentTool, {
      toolsByName: new Map([[fastAgentTool.name, fastAgentTool]]),
      onProgress: () => {},
    });
    expect(bridged.name).toBe("greet");
    expect(bridged.parameters).toMatchObject({ type: "object", required: ["name"] });

    const execCtx = { callId: "tc-1", signal: new AbortController().signal, concludeTurn: () => {} } as never;
    const out = await bridged.execute({ name: "Ada" }, execCtx);
    expect(out).toEqual({ text: "Hello, Ada!" });
    expect(bridged.output.render?.({} as never, out as never)).toEqual([{ type: "text", text: "Hello, Ada!" }]);

    await expect(bridged.execute({ name: 123 }, execCtx)).rejects.toThrow(/Invalid arguments/);
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

  it("resolveConfinedPath blocks traversal, outside absolutes, symlink escapes, and dangling symlinks", () => {
    const root = mkdtempSync(join(tmpdir(), "dsh-confine-"));
    const workspace = join(root, "ws");
    const outside = join(root, "outside");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const secretFile = join(outside, "secret.txt");
    writeFileSync(secretFile, "secret");
    writeFileSync(join(workspace, "ok.txt"), "ok");
    symlinkSync(secretFile, join(workspace, "link-file.txt"));
    symlinkSync(outside, join(workspace, "link-dir"));
    symlinkSync(join(outside, "future.txt"), join(workspace, "dangling.txt"));
    symlinkSync(join(outside, "nonexistent-dir"), join(workspace, "dangling-dir"));

    try {
      expect(resolveConfinedPath(workspace, "ok.txt")).toContain("ok.txt");
      expect(resolveConfinedPath(workspace, "sub/new.txt")).toContain("new.txt");
      expect(() => resolveConfinedPath(workspace, "../outside/secret.txt")).toThrow(/escapes workspace/);
      expect(() => resolveConfinedPath(workspace, secretFile)).toThrow(/escapes workspace/);
      expect(() => resolveConfinedPath(workspace, "link-file.txt")).toThrow(/escapes workspace/);
      expect(() => resolveConfinedPath(workspace, "link-dir/new.txt")).toThrow(/escapes workspace/);
      expect(() => resolveConfinedPath(workspace, "dangling.txt")).toThrow(/Refusing dangling symlink/);
      expect(() => resolveConfinedPath(workspace, "dangling-dir/nested.txt")).toThrow(/Refusing dangling symlink/);
      expect(() => resolveConfinedPath(workspace, "ok.txt\0bad")).toThrow(/NUL bytes/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("wires codingTools gating, read/write/edit confinement, read-only enforcement, and openDshAgentFromDir", async () => {
    const { createFauxCore, createModels, createProvider, fauxAssistantMessage, fauxToolCall } = await import(
      "@earendil-works/pi-ai"
    );
    const root = mkdtempSync(join(tmpdir(), "dsh-dir-"));
    const agentDir = join(root, "my-agent");
    mkdirSync(join(agentDir, "skills", "deploy"), { recursive: true });
    mkdirSync(join(agentDir, "prompts"), { recursive: true });
    writeFileSync(join(agentDir, "SYSTEM.md"), "You are a sandboxed engineer.");
    writeFileSync(join(agentDir, "AGENTS.md"), "Always follow workspace rules.");
    writeFileSync(
      join(agentDir, "skills", "deploy", "SKILL.md"),
      "---\nname: deploy\ndescription: Ship releases safely\n---\nRun deploy.",
    );
    writeFileSync(
      join(agentDir, "prompts", "review.md"),
      "---\ndescription: Review a branch\n---\nPlease review: $ARGUMENTS",
    );

    const makeModels = (
      handler: (ctx: { messages: readonly { role: string; content: unknown; isError?: boolean }[] }) => unknown,
    ) => {
      const core = createFauxCore({ provider: "dir", api: "dir" });
      const stream = (...args: Parameters<typeof core.streamSimple>) => {
        core.appendResponses([handler(args[1] as never) as never]);
        return core.streamSimple(...args);
      };
      const models = createModels();
      models.setProvider(
        createProvider({
          id: "dir",
          auth: { apiKey: { name: "Dir", resolve: async () => ({ auth: {} }) } },
          models: core.models,
          api: { stream, streamSimple: stream },
        }),
      );
      return { models, model: { provider: "dir", modelId: core.getModel().id } };
    };

    try {
      // Duplicate coding tool name fails fast.
      await expect(
        openDshAgent({
          name: "dup",
          workdir: agentDir,
          codingTools: ["read"],
          tools: [
            defineTool({
              name: "read",
              description: "conflict",
              parameters: { type: "object", properties: {} } as const,
              execute: async () => "x",
            }),
          ],
          sandbox: "off",
        }),
      ).rejects.toMatchObject({ code: "invalid_request" });

      // openDshAgentFromDir loads SYSTEM.md, AGENTS.md, skills, prompts, SQLite storage, and codingTools.
      let seenSystem = "";
      let seenUser = "";
      const { models, model } = makeModels((ctx) => {
        const last = ctx.messages.at(-1);
        if (last?.role === "toolResult") {
          const text = Array.isArray(last.content)
            ? ((last.content[0] as { text?: string } | undefined)?.text ?? "")
            : String(last.content);
          return fauxAssistantMessage(`${last.isError ? "ERR" : "OK"}:${text}`);
        }
        seenSystem = ctx.messages
          .filter((m) => m.role === "system")
          .map((m) => String(m.content))
          .join("\n");
        seenUser = typeof last?.content === "string" ? last.content : "";
        if (seenUser === "write-ok") {
          return fauxAssistantMessage([fauxToolCall("write", { path: "note.txt", content: "hello world" })], {
            stopReason: "toolUse",
          });
        }
        if (seenUser === "edit-ok") {
          return fauxAssistantMessage([fauxToolCall("edit", { path: "note.txt", oldText: "world", newText: "dsh" })], {
            stopReason: "toolUse",
          });
        }
        if (seenUser === "read-ok") {
          return fauxAssistantMessage([fauxToolCall("read", { path: "note.txt" })], { stopReason: "toolUse" });
        }
        if (seenUser === "escape") {
          return fauxAssistantMessage([fauxToolCall("write", { path: "../escaped.txt", content: "bad" })], {
            stopReason: "toolUse",
          });
        }
        if (seenUser === "clobber-state") {
          return fauxAssistantMessage(
            [fauxToolCall("write", { path: ".fastagent/dsh.sqlite", content: "corrupted" })],
            { stopReason: "toolUse" },
          );
        }
        return fauxAssistantMessage(`echo:${seenUser}`);
      });

      const agent = await openDshAgentFromDir(agentDir, { models, model, codingTools: ["read", "write", "edit"] });
      try {
        const info = await agent.info();
        expect(info.name).toBe("my-agent");
        expect(info.tools.map((t) => t.name)).toEqual(["read", "write", "edit"]);
        expect(info.commands).toEqual([{ name: "review", description: "Review a branch" }]);

        const session = await agent.sessions.create();
        const cmdRes = await agent.messages.send({ sessionId: session.id, content: "/review main" }, { wait: 10 });
        expect(cmdRes.answer?.text).toBe("echo:Please review: main");
        expect(seenSystem).toContain("You are a sandboxed engineer.");
        expect(seenSystem).toContain("Always follow workspace rules.");
        expect(seenSystem).toContain("deploy");

        expect(
          (await agent.messages.send({ sessionId: session.id, content: "write-ok" }, { wait: 10 })).answer?.text,
        ).toContain("OK:");
        expect(
          (await agent.messages.send({ sessionId: session.id, content: "edit-ok" }, { wait: 10 })).answer?.text,
        ).toContain("OK:");
        expect(
          (await agent.messages.send({ sessionId: session.id, content: "read-ok" }, { wait: 10 })).answer?.text,
        ).toBe("OK:hello dsh");
        expect(readFileSync(join(agentDir, "note.txt"), "utf8")).toBe("hello dsh");

        const escaped = await agent.messages.send({ sessionId: session.id, content: "escape" }, { wait: 10 });
        expect(escaped.answer?.text).toContain("ERR:");
        expect(existsSync(join(root, "escaped.txt"))).toBe(false);
        const clobber = await agent.messages.send({ sessionId: session.id, content: "clobber-state" }, { wait: 10 });
        expect(clobber.answer?.text).toContain("path is protected");
        expect(existsSync(join(agentDir, ".fastagent", "dsh.sqlite"))).toBe(true);
      } finally {
        await agent.close();
      }

      // read-only sandbox denies write & edit while still allowing read.
      const ro = await openDshAgentFromDir(agentDir, {
        models,
        model,
        sandbox: "read-only",
        codingTools: ["read", "write", "edit"],
      });
      try {
        const s = await ro.sessions.create();
        expect((await ro.messages.send({ sessionId: s.id, content: "read-ok" }, { wait: 10 })).answer?.text).toBe(
          "OK:hello dsh",
        );
        expect((await ro.messages.send({ sessionId: s.id, content: "write-ok" }, { wait: 10 })).answer?.text).toContain(
          "read-only mode",
        );
        expect((await ro.messages.send({ sessionId: s.id, content: "edit-ok" }, { wait: 10 })).answer?.text).toContain(
          "read-only mode",
        );
      } finally {
        await ro.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
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
      const held = await openPostgresDshStore(db, instanceA, { leaseMs: 5_000, owner: "holder-1" });
      await expect(
        openPostgresDshStore(db, instanceA, { leaseMs: 5_000, waitMs: 0, owner: "holder-2" }),
      ).rejects.toThrow(DshInstanceHeldError);

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
      // Simulate expired lease takeover: once another owner claims the lease, the fenced holder's writes fail.
      await db.query("UPDATE dsh_leases SET lease_until = 1 WHERE instance = $1", [instanceA]);
      const successor = await openPostgresDshStore(db, instanceA, { leaseMs: 5_000, waitMs: 0, owner: "holder-2" });
      await expect(hA.append([{ seq: 1, type: "turn/end", data: { turn: 1 } }])).rejects.toThrow(/lease.*lost/);
      await expect(
        held.putMessage?.({
          id: "fenced-msg",
          sessionId: "shared-id",
          status: "queued",
          whenBusy: "queue",
          displayContent: [{ type: "text", text: "stale" }],
          modelContent: [{ type: "text", text: "stale" }],
          createdAt: 1,
          updatedAt: 1,
        }),
      ).rejects.toThrow(/lease.*lost/);
      await successor.close();
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

describe("openAgent harness switching and shared agent.sqlite coexistence", () => {
  it("switches between pi-durable and dsh on the same agent.sqlite, warns/skips pi-durable extensions, and preserves both harnesses' sessions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fa-switch-harness-"));
    const root = mkdtempSync(join(tmpdir(), "fa-switch-root-"));
    try {
      mkdirSync(join(dir, "src", "tools"), { recursive: true });
      mkdirSync(join(dir, "src", "extensions"), { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "switch-agent", type: "module" }));
      writeFileSync(join(dir, "SYSTEM.md"), "You are a portable agent.\n");
      writeFileSync(
        join(dir, "fastagent.config.ts"),
        `import { createFauxCore, createProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { defineAgent } from "@fastagent-sh/fastagent";
const core = createFauxCore({ provider: "sw", api: "sw" });
const stream = (...args) => {
  const last = args[1].messages.at(-1);
  if (last?.role === "toolResult") {
    const text = Array.isArray(last.content) ? (last.content[0]?.text ?? "") : String(last.content);
    core.appendResponses([fauxAssistantMessage("tool-ok:" + text)]);
  } else {
    const text = typeof last?.content === "string" ? last.content : Array.isArray(last?.content) ? last.content.map((p) => p.text ?? "").join("") : "";
    core.appendResponses([
      text === "use-ping"
        ? fauxAssistantMessage([fauxToolCall("ping", { msg: "hi" })], { stopReason: "toolUse" })
        : fauxAssistantMessage("reply:" + text),
    ]);
  }
  return core.streamSimple(...args);
};
export default defineAgent({
  model: "sw/" + core.getModel().id,
  codingTools: ["read"],
  providers: [
    createProvider({
      id: "sw",
      auth: { apiKey: { name: "SW", resolve: async () => ({ auth: {} }) } },
      models: core.models,
      api: { stream, streamSimple: stream },
    }),
  ],
});
`,
      );
      writeFileSync(
        join(dir, "src", "tools", "ping.ts"),
        `import { defineTool } from "@fastagent-sh/fastagent";
export default defineTool({
  name: "ping",
  description: "Echo a ping message",
  parameters: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] } as const,
  execute: async ({ msg }) => "pong:" + msg,
});
`,
      );
      // A pi-durable-only extension: runs on pi-durable, warns and is skipped on dsh without blocking startup.
      writeFileSync(
        join(dir, "src", "extensions", "legacy.ts"),
        `export default { name: "legacy-ext", tools: [] };
`,
      );

      const definition = await loadSourceDefinition(dir);

      // 1) Open on pi-durable and create a session in <root>/.state/agent.sqlite.
      const piAgent1 = await openAgent(definition, { root });
      const piSession = await piAgent1.sessions.create({ title: "pi-session" });
      const piMsg = await piAgent1.messages.send({ sessionId: piSession.id, content: "from-pi" }, { wait: 15 });
      expect(piMsg.answer?.text).toBe("reply:from-pi");
      await piAgent1.close();

      // 2) Switch to dsh on the EXACT SAME <root>/.state/agent.sqlite — skips legacy-ext, runs defineTool, serves HTTP.
      const dshAgent1 = await openAgent(definition, { root, harness: "dsh", sandbox: "workspace" });
      const dshInfo = await dshAgent1.info();
      expect(dshInfo.tools.map((t) => t.name)).toEqual(["read", "ping"]);
      const dshSession = await dshAgent1.sessions.create({ title: "dsh-session" });
      const dshMsg = await dshAgent1.messages.send({ sessionId: dshSession.id, content: "use-ping" }, { wait: 15 });
      expect(dshMsg.answer?.text).toBe("tool-ok:pong:hi");
      const dshConv1 = await dshAgent1.invoke({ conversation: "ops", content: "use-ping" }, { wait: 15 });
      expect(dshConv1.answer?.text).toBe("tool-ok:pong:hi");
      const service = await dshAgent1.serve({ apiKeys: ["k"] });
      const health = await service.fetch(new Request("http://local/health"));
      expect(health.status).toBe(200);
      await dshAgent1.close();

      // 3) Switch back to pi-durable on the same agent.sqlite: pi-session is intact.
      const piAgent2 = await openAgent(definition, { root });
      expect((await piAgent2.sessions.get(piSession.id)).title).toBe("pi-session");
      await piAgent2.close();

      // 4) Switch back to dsh on the same agent.sqlite: dsh-session and named conversation are intact.
      const dshAgent2 = await openAgent(definition, { root, harness: "dsh", sandbox: "workspace" });
      expect((await dshAgent2.sessions.get(dshSession.id)).title).toBe("dsh-session");
      const dshConv2 = await dshAgent2.invoke({ conversation: "ops", content: "use-ping" }, { wait: 15 });
      expect(dshConv2.sessionId).toBe(dshConv1.sessionId);
      await dshAgent2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});

agentApiConformance("dsh (sqlite)", dshSubject());
