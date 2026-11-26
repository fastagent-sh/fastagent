import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as EffectSchema from "effect/Schema";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { defineTool, sessionIdOf } from "@fastagent-sh/fastagent";
import { MemoryDshEventStore, openDshAgent, openSqliteDshStore } from "@fastagent-sh/harness-dsh";
import { DshInstanceHeldError, openPostgresDshStore } from "@fastagent-sh/harness-dsh/internal";
import {
  buildDshSandboxPolicy,
  resolveConfinedPath,
  verifyBashSandbox,
} from "../../../packages/harness-dsh/src/sandbox.ts";
import { classifyPiError } from "../../../packages/harness-dsh/src/llm-pi-ai.ts";
import { classifyLlmFailure, isRetryableLlmFailure } from "../../../packages/harness-dsh/src/projection.ts";
import { bridgeDshRuntimeTool } from "../../../packages/harness-dsh/src/tools.ts";
import { openPgDatabase, openPostgresDatabase } from "../../../packages/fastagent/src/postgres.ts";
import {
  acquirePgInstanceLease,
  isPgConflict,
  migratePgSchema,
  splitPgText,
} from "../../../packages/fastagent/src/postgres-kit.ts";
import { loadSourceDefinition } from "../../../packages/fastagent/src/harnesses/assembly.ts";
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

    const innerTool = defineTool({
      name: "inner_sid",
      description: "Read session id inside nested executeTool",
      parameters: { type: "object", properties: {} } as const,
      execute: async (_args, api, ctx) => `sid=${await sessionIdOf(api, ctx)}`,
    });
    const outerTool = defineTool({
      name: "outer_stream",
      description: "Nested executeTool + maxLines output retention",
      parameters: { type: "object", properties: {} } as const,
      outputLimits: { maxLines: 2, retain: "tail" },
      execute: async (_args, api, ctx) => {
        const nested = (await api.executeTool("inner_sid", {}, ctx)) as {
          readonly output?: ReadonlyArray<{ readonly text?: string }>;
        };
        api.output("l1\nl2\nl3\n");
        api.output(`${nested.output?.[0]?.text ?? "missing"}\n`);
        return {};
      },
    });
    const headStreamTool = defineTool({
      name: "head_stream",
      description: "Head maxLines output retention across chunks",
      parameters: { type: "object", properties: {} } as const,
      outputLimits: { maxLines: 2, retain: "head" },
      execute: async (_args, api) => {
        api.output("h1\nh2\n");
        api.output("h3\n");
        api.output("h4\n");
        return {};
      },
    });
    const toolsByName = new Map([
      [innerTool.name, innerTool],
      [outerTool.name, outerTool],
      [headStreamTool.name, headStreamTool],
    ]);
    const bridgedOuter = bridgeDshRuntimeTool(outerTool, { toolsByName, onProgress: () => {} });
    const bridgedHead = bridgeDshRuntimeTool(headStreamTool, { toolsByName, onProgress: () => {} });
    const nestedExecCtx = {
      callId: "tc-2",
      agent: { id: "dsh-sess-9" },
      signal: new AbortController().signal,
      concludeTurn: () => {},
    } as never;
    expect(await bridgedOuter.execute({}, nestedExecCtx)).toEqual({ text: "l3\nsid=dsh-sess-9" });
    expect(await bridgedHead.execute({}, nestedExecCtx)).toEqual({ text: "h1\nh2" });
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

  it("wires codingTools gating, read/write/edit confinement, read-only enforcement, and directory loading via openAgent", async () => {
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

      // openDshAgent with workspace codingTools + protectedPaths + SQLite storage.
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

      const sqlStore = openSqliteDshStore(join(agentDir, ".fastagent", "dsh.sqlite"));
      const agent = await openDshAgent({
        name: "my-agent",
        workdir: agentDir,
        systemPrompt: "You are a sandboxed engineer.\nAlways follow workspace rules.\ndeploy",
        models,
        model,
        codingTools: ["read", "write", "edit"],
        protectedPaths: [join(agentDir, ".fastagent")],
        commands: () => [
          { name: "review", description: "Review a branch", expand: (args) => `Please review: ${args}` },
        ],
        storage: sqlStore,
      });
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
        await sqlStore.close();
      }

      // read-only sandbox denies write & edit while still allowing read.
      const ro = await openDshAgent({
        name: "my-agent",
        workdir: agentDir,
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
  const pgKit = {
    migrate: migratePgSchema,
    acquireLease: acquirePgInstanceLease,
    splitText: splitPgText,
    isConflict: isPgConflict,
  } as const;
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
      const held = await openPostgresDshStore(db, instanceA, { leaseMs: 5_000, owner: "holder-1", kit: pgKit });
      await expect(
        openPostgresDshStore(db, instanceA, { leaseMs: 5_000, waitMs: 0, owner: "holder-2", kit: pgKit }),
      ).rejects.toThrow(DshInstanceHeldError);

      // Multi-instance isolation on the same database.
      const other = await openPostgresDshStore(db, instanceB, { leaseMs: 5_000, owner: "holder-b", kit: pgKit });
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
      await db.query("UPDATE dsh_leases SET lease_until = now() - interval '1 second' WHERE instance = $1", [
        instanceA,
      ]);
      const successor = await openPostgresDshStore(db, instanceA, {
        leaseMs: 5_000,
        waitMs: 0,
        owner: "holder-2",
        kit: pgKit,
      });
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

      let lostReason: Error | undefined;
      const instanceWatched = freshInstance();
      const watchedHolder = await openPostgresDshStore(db, instanceWatched, {
        leaseMs: 5_000,
        waitMs: 0,
        owner: "holder-watched",
        kit: pgKit,
        onLost: (error) => {
          lostReason = error;
        },
      });
      await db.query("UPDATE dsh_leases SET lease_until = now() - interval '1 second' WHERE instance = $1", [
        instanceWatched,
      ]);
      const takeover = await openPostgresDshStore(db, instanceWatched, {
        leaseMs: 5_000,
        waitMs: 0,
        owner: "holder-takeover",
        kit: pgKit,
      });
      const hWatched = await watchedHolder
        .create({ version: 4, id: "lost-id", createdAt: 1, isSeeded: false })
        .catch(() => undefined);
      expect(hWatched).toBeUndefined();
      expect(lostReason?.message).toMatch(/lease.*lost/);
      await takeover.close();
      await watchedHolder.close();
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

      const store1 = await openPostgresDshStore(db, freshInstance(), { kit: pgKit });
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
      const store2 = await openPostgresDshStore(db, pgInstanceName, { kit: pgKit });
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

      // Verify openAgent({ harness: "dsh", database }) resolves `agent.closed` on Postgres lease loss.
      const leaseInstance = freshInstance();
      const dshDir = mkdtempSync(join(tmpdir(), "fa-dsh-pg-close-"));
      try {
        writeFileSync(join(dshDir, "package.json"), JSON.stringify({ name: "dsh-pg-close", type: "module" }));
        writeFileSync(join(dshDir, "fastagent.config.ts"), "export default {};\n");
        const def = await loadSourceDefinition(dshDir);
        const openedPg = await openAgent(def, {
          root: dshDir,
          name: leaseInstance,
          harness: "dsh",
          sandbox: "off",
          database: { url: postgres.url },
        });
        let closedResolved = false;
        void openedPg.closed?.then(() => {
          closedResolved = true;
        });
        await db.query("UPDATE dsh_leases SET lease_until = now() - interval '1 second' WHERE instance = $1", [
          leaseInstance,
        ]);
        const thief = await openPostgresDshStore(db, leaseInstance, {
          leaseMs: 5_000,
          waitMs: 0,
          owner: "thief",
          kit: pgKit,
        });
        await expect(openedPg.sessions.create()).rejects.toThrow(/lease.*lost/);
        await thief.close();
        await vi.waitFor(() => {
          expect(closedResolved).toBe(true);
        });
        await openedPg.close();
      } finally {
        rmSync(dshDir, { recursive: true, force: true });
      }
    } finally {
      await db.close();
    }
  });

  it("supports Aurora DSQL async unique indexes, UTF-8 value chunking, multi-tx batching, and shared-pool single-flight migration", async () => {
    const fresh = await servedPostgres();
    const indexStatements: string[] = [];
    const createIndex = async (
      exec: {
        query<T extends object = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]>;
      },
      statement: string,
    ) => {
      indexStatements.push(statement);
      await exec.query(statement);
      return async () => {};
    };
    const tightLimits = { rowsPerTransaction: 25, bytesPerTransaction: 16 * 1024, bytesPerValue: 128 };
    const shared = openPostgresDatabase({ url: fresh.url, createIndex, limits: tightLimits }, { max: 4 });
    const dir = mkdtempSync(join(tmpdir(), "fa-dsh-dsql-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "dsh-dsql", type: "module" }));
      writeFileSync(join(dir, "fastagent.config.ts"), "export default {};\n");
      const def = await loadSourceDefinition(dir);

      // Concurrent opens on a SharedPostgresDatabase run DSH migration once and route CREATE UNIQUE INDEX via createIndex.
      const [a, b] = await Promise.all([
        openAgent(def, { root: dir, name: "dsql-tenant-a", harness: "dsh", sandbox: "off", database: shared }),
        openAgent(def, { root: dir, name: "dsql-tenant-b", harness: "dsh", sandbox: "off", database: shared }),
      ]);
      expect(indexStatements).toEqual([
        expect.stringMatching(/^CREATE UNIQUE INDEX IF NOT EXISTS dsh_messages_by_idempotency\b/),
      ]);
      await a.close();
      await b.close();

      // Direct store test under tight limits using the shared postgres-kit: chunked header/meta/message/attachment/events + multi-tx append.
      const db = openPgDatabase(fresh.url);
      try {
        const instance = freshInstance();
        const txQueries: string[] = [];
        let readTxCount = 0;
        const instrumentedDb = {
          query: db.query.bind(db),
          transaction: async <T>(work: Parameters<typeof db.transaction<T>>[0]) => {
            let sawWrite = false;
            const result = await db.transaction(async (tx) =>
              work({
                query: async <U extends object>(text: string, params?: readonly unknown[]) => {
                  txQueries.push(text);
                  if (/^\s*(?:INSERT|UPDATE|DELETE)\b/i.test(text)) sawWrite = true;
                  return tx.query<U>(text, params);
                },
              }),
            );
            if (!sawWrite) readTxCount += 1;
            return result;
          },
        };
        let unexpectedLost: Error | undefined;
        const store = await openPostgresDshStore(instrumentedDb, instance, {
          createIndex,
          limits: tightLimits,
          onLost: (err) => {
            unexpectedLost = err;
          },
          kit: {
            migrate: migratePgSchema,
            acquireLease: acquirePgInstanceLease,
            splitText: splitPgText,
            isConflict: isPgConflict,
          },
        });
        txQueries.length = 0;
        readTxCount = 0;
        const longHeaderNote = "头信息🚀".repeat(60);
        const header = {
          version: 4,
          id: "s-chunked",
          createdAt: 1_700_000_000_000,
          isSeeded: false,
          note: longHeaderNote,
        } as unknown as { version: number; id: string; createdAt: number; isSeeded: boolean };
        const handle = await store.create(header);

        // Updating metadata on an existing session preserves the chunked header in dsh_values.
        const longTitle = "标题✨".repeat(50);
        await store.putSessionMeta?.({
          id: "s-chunked",
          order: 0,
          deleted: false,
          inheritedEntryCount: 0,
          title: longTitle,
          instructions: "x".repeat(300),
          model: { provider: "p", modelId: "m" },
          thinkingLevel: "off",
          createdAt: 1,
          updatedAt: 2,
          usage: { models: {}, tools: {} },
        });
        expect((await store.stat("s-chunked"))?.header).toEqual(header);
        expect((await store.getSessionMeta?.("s-chunked"))?.title).toBe(longTitle);

        // Append more events than rowsPerTransaction with payloads exceeding bytesPerValue (forces multi-tx + chunking).
        const events = Array.from({ length: 15 }, (_, seq) => ({
          seq,
          type: "chunk/event",
          data: { seq, body: `片段-${seq}-中文😀`.repeat(20) },
        }));
        await handle.append(events);
        const readBack = await handle.read(0);
        expect(readBack.events).toEqual(events);

        // Oversized message + attachment round-trip via dsh_values and idempotency key lookup.
        const bigMessage = {
          id: "m-big",
          sessionId: "s-chunked",
          idempotencyKey: "idem-dsql-1",
          status: "completed" as const,
          whenBusy: "queue" as const,
          displayContent: [{ type: "text" as const, text: "消息体🎉".repeat(80) }],
          modelContent: [{ type: "text" as const, text: "消息体🎉".repeat(80) }],
          createdAt: 1,
          updatedAt: 2,
        };
        await store.putMessage?.(bigMessage);
        expect(await store.getMessageByKey?.("s-chunked", "idem-dsql-1")).toEqual(bigMessage);
        expect(await store.getMessage?.("s-chunked", "m-big")).toEqual(bigMessage);

        const rawBytes = new Uint8Array(600);
        for (let i = 0; i < rawBytes.length; i++) rawBytes[i] = i & 0xff;
        await store.putAttachment?.({
          ref: "att-big",
          sessionId: "s-chunked",
          mimeType: "application/octet-stream",
          data: rawBytes,
        });
        const fetchedAttachment = await store.getAttachment?.("s-chunked", "att-big");
        expect(fetchedAttachment?.data).toEqual(rawBytes);

        // Single event exceeding bytesPerTransaction fails visibly.
        await expect(handle.append([{ seq: 15, type: "huge", data: { text: "z".repeat(20 * 1024) } }])).rejects.toThrow(
          /exceeds the database transaction limit/,
        );

        const partRows = await db.query<{ count: string | number }>(
          "SELECT COUNT(*) AS count FROM dsh_values WHERE instance = $1",
          [instance],
        );
        expect(Number(partRows[0]?.count ?? 0)).toBeGreaterThan(0);

        // P0 regression: write transactions fence via dsh_metadata and never UPDATE dsh_leases, and concurrent writes
        // alongside lease renewal never self-conflict or trigger onLost.
        expect(txQueries.some((sql) => sql.includes("UPDATE dsh_leases"))).toBe(false);
        expect(txQueries.some((sql) => sql.includes("UPDATE dsh_metadata"))).toBe(true);
        // P1 regression: chunked reads run inside a single REPEATABLE READ transaction snapshot to prevent torn reads.
        expect(readTxCount).toBeGreaterThan(0);

        await Promise.all([
          ...Array.from({ length: 6 }, (_, idx) =>
            store.putMessage?.({
              id: "m-concurrent",
              sessionId: "s-chunked",
              whenBusy: "queue",
              status: idx % 2 === 0 ? "running" : "completed",
              displayContent: [{ type: "text", text: `版本-${idx}-`.repeat(50) }],
              modelContent: [{ type: "text", text: `版本-${idx}-`.repeat(50) }],
              createdAt: 1,
              updatedAt: 10 + idx,
            }),
          ),
          ...Array.from({ length: 6 }, () => store.getMessage?.("s-chunked", "m-concurrent")),
          db.query(
            "UPDATE dsh_leases SET lease_until = now() + interval '30 seconds' WHERE instance = $1 AND owner = $2",
            [instance, store.owner],
          ),
        ]);
        expect(unexpectedLost).toBeUndefined();
        const finalConcurrent = await store.getMessage?.("s-chunked", "m-concurrent");
        expect(finalConcurrent?.id).toBe("m-concurrent");

        await handle.close();
        await store.close();

        // P1 regression: openAgent({ harness: "dsh", database }) waits for a briefly held lease to release instead of
        // failing immediately with waitMs = 0.
        const handoffInstance = freshInstance();
        const priorHolder = await openPostgresDshStore(db, handoffInstance, {
          leaseMs: 5_000,
          waitMs: 0,
          owner: "prior-holder",
          kit: pgKit,
        });
        const releaseTimer = setTimeout(() => {
          void priorHolder.close();
        }, 120);
        try {
          const handedOff = await openAgent(def, {
            root: dir,
            name: handoffInstance,
            harness: "dsh",
            sandbox: "off",
            database: shared,
          });
          await handedOff.close();
        } finally {
          clearTimeout(releaseTimer);
          await priorHolder.close();
        }

        // Cooperative idle handoff on DSH: a second openAgent takes over an idle holder on its next renewal tick.
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        let coopFirst: Awaited<ReturnType<typeof openAgent>> | undefined;
        let coopSecond: Awaited<ReturnType<typeof openAgent>> | undefined;
        try {
          const coopInstance = freshInstance();
          let coopFirstClosed = false;
          coopFirst = await openAgent(def, {
            root: dir,
            name: coopInstance,
            harness: "dsh",
            sandbox: "off",
            database: shared,
          });
          void coopFirst.closed?.then(() => {
            coopFirstClosed = true;
          });
          const openingSecond = openAgent(def, {
            root: dir,
            name: coopInstance,
            harness: "dsh",
            sandbox: "off",
            database: { url: fresh.url },
          });
          await vi.waitFor(
            async () => {
              const [row] = await db.query<{ handoff_requested_at: Date | null }>(
                "SELECT handoff_requested_at FROM dsh_leases WHERE instance = $1",
                [coopInstance],
              );
              expect(row?.handoff_requested_at).not.toBeNull();
            },
            { timeout: 5_000 },
          );
          await vi.advanceTimersByTimeAsync(8_000);
          coopSecond = await openingSecond;
          await vi.waitFor(() => expect(coopFirstClosed).toBe(true), { timeout: 5_000 });
          const created = await coopSecond.sessions.create({ title: "After DSH Handoff" });
          expect((await coopSecond.sessions.get(created.id)).title).toBe("After DSH Handoff");
        } finally {
          await coopSecond?.close();
          await coopFirst?.close();
          vi.useRealTimers();
        }
      } finally {
        await db.close();
      }
    } finally {
      await shared.close();
      await fresh.close();
      rmSync(dir, { recursive: true, force: true });
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
    const sys = args[1].messages.filter((m) => m.role === "system").map((m) => String(m.content)).join("\\n");
    core.appendResponses([
      text === "use-ping"
        ? fauxAssistantMessage([fauxToolCall("ping", { msg: "hi" })], { stopReason: "toolUse" })
        : text === "use-park"
          ? fauxAssistantMessage([fauxToolCall("park", {})], { stopReason: "toolUse" })
          : text === "check-live"
          ? fauxAssistantMessage("sys:" + (sys.includes("Updated live prompt.") ? "updated" : "stale"))
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
        `import { defineTool, sessionIdOf } from "@fastagent-sh/fastagent";
export default defineTool({
  name: "ping",
  description: "Echo a ping message",
  parameters: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] } as const,
  execute: async ({ msg }, api, context) => {
    const sid = await sessionIdOf(api, context);
    return "pong:" + msg + ":" + String(sid);
  },
});
`,
      );
      writeFileSync(
        join(dir, "src", "tools", "park.ts"),
        `import { defineTool } from "@earendil-works/pi-durable";
export default defineTool({
  name: "park",
  description: "Returns a pi-durable-only park result",
  parameters: { type: "object", properties: {} },
  execute: async () => ({ sleep: { until: Date.now() + 1000 } }),
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
      expect(dshInfo.tools.map((t) => t.name)).toEqual(["read", "park", "ping"]);
      const dshSession = await dshAgent1.sessions.create({ title: "dsh-session" });
      const dshMsg = await dshAgent1.messages.send({ sessionId: dshSession.id, content: "use-ping" }, { wait: 15 });
      expect(dshMsg.answer?.text).toBe(`tool-ok:pong:hi:${dshSession.id}`);
      // A pi-durable-only park return fails only that tool call cleanly; the harness and other tools stay unaffected.
      const dshParkMsg = await dshAgent1.messages.send({ sessionId: dshSession.id, content: "use-park" }, { wait: 15 });
      expect(dshParkMsg.answer?.text).toMatch(
        /returned a park response \(sleep\/wait\), which requires harness: "pi-durable"/,
      );
      const dshConv1 = await dshAgent1.invoke({ conversation: "ops", content: "use-ping" }, { wait: 15 });
      expect(dshConv1.answer?.text).toBe(`tool-ok:pong:hi:${dshConv1.sessionId}`);
      // Live SYSTEM.md updates take effect on the next DSH message without restarting.
      writeFileSync(join(dir, "SYSTEM.md"), "Updated live prompt.\n");
      const liveSystemReply = await dshAgent1.messages.send(
        { sessionId: dshSession.id, content: "check-live" },
        { wait: 15 },
      );
      expect(liveSystemReply.answer?.text).toBe("sys:updated");
      const service = await dshAgent1.serve({ apiKeys: ["k"] });
      expect(dshAgent1.ready()).toBe(true);
      expect(service.ready()).toBe(true);
      const health = await service.fetch(new Request("http://local/health"));
      expect(health.status).toBe(200);
      await dshAgent1.close();
      expect(dshAgent1.ready()).toBe(false);
      expect(service.ready()).toBe(false);
      expect((await service.fetch(new Request("http://local/health"))).status).toBe(503);

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

      // 5) Enforce maxMessageBytes (including expanded commands) and unusableDefault on openDshAgent parity.
      const limited = await openDshAgent({
        name: "limited",
        workdir: dir,
        unusableDefault: { spec: "sw/retired", reason: 'no provider "sw" offers "retired"' },
        commands: () => [{ name: "big", description: "Expands large", expand: () => "x".repeat(64) }],
        maxMessageBytes: 48,
        sandbox: "off",
      });
      try {
        expect((await limited.info()).unusableDefault).toEqual({
          spec: "sw/retired",
          reason: 'no provider "sw" offers "retired"',
        });
        const ls = await limited.sessions.create();
        await expect(limited.messages.send({ sessionId: ls.id, content: "x".repeat(64) })).rejects.toMatchObject({
          code: "invalid_request",
          details: { reason: "too_large" },
        });
        await expect(limited.messages.send({ sessionId: ls.id, content: "/big" })).rejects.toMatchObject({
          code: "invalid_request",
          details: { reason: "too_large" },
        });
      } finally {
        await limited.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("verifies bash OS sandbox fail-fast and skips probing when bash or sandbox is off", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "fa-dsh-sandbox-preflight-"));
    try {
      await expect(verifyBashSandbox(undefined, { workdir, mode: "read-only" })).rejects.toMatchObject({
        code: "unavailable",
        message: expect.stringMatching(/no sandbox provider is available/),
      });

      const failingConfine = vi.fn(async () => {
        throw new Error("SANDBOX_UNAVAILABLE: neither bwrap nor landlock is usable");
      });
      await expect(
        verifyBashSandbox({ confine: failingConfine }, { workdir, mode: "read-only" }),
      ).rejects.toMatchObject({
        code: "unavailable",
        message: expect.stringMatching(/OS sandbox \(read-only\) is unavailable for bash tools.*SANDBOX_UNAVAILABLE/),
      });
      expect(failingConfine).toHaveBeenCalledTimes(1);

      const passingConfine = vi.fn(async () => ({
        argv: ["bwrap", "--", "true"],
        enforcement: "full" as const,
        denialSignatures: [],
        runnerFailureRules: [],
      }));
      await verifyBashSandbox({ confine: passingConfine }, { workdir, mode: "off" });
      expect(passingConfine).not.toHaveBeenCalled();

      await verifyBashSandbox({ confine: passingConfine }, { workdir, mode: "workspace" });
      expect(passingConfine).toHaveBeenCalledTimes(1);
      expect(passingConfine).toHaveBeenCalledWith(["true"], expect.objectContaining({ mode: "workspace-write" }));

      // Real openDshAgent entry must fail fast (and dispose Cordis) when the host has no usable OS sandbox.
      const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
      Object.defineProperty(process, "platform", { value: "freebsd", configurable: true });
      try {
        await expect(
          openDshAgent({
            name: "unsupported-sandbox-host",
            workdir,
            sandbox: "read-only",
            codingTools: ["read", "bash"],
          }),
        ).rejects.toMatchObject({
          code: "unavailable",
          message: expect.stringMatching(/OS sandbox \(read-only\) is unavailable for bash tools/),
        });
      } finally {
        if (originalPlatform !== undefined) Object.defineProperty(process, "platform", originalPlatform);
      }

      // Without bash or with sandbox: "off", openDshAgent boots without requiring an OS subprocess sandbox.
      const readOnlyNoBash = await openDshAgent({
        name: "no-bash",
        workdir,
        sandbox: "read-only",
        codingTools: ["read"],
      });
      await readOnlyNoBash.close();
      const unconfinedBash = await openDshAgent({
        name: "sandbox-off",
        workdir,
        sandbox: "off",
        codingTools: ["read", "bash"],
      });
      await unconfinedBash.close();
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("classifies pi-ai errors via HTTP status and pi-ai retry rules without misclassifying 400s as auth", () => {
    const errMsg = (errorMessage: string) => ({ stopReason: "error", errorMessage }) as never;

    expect(classifyPiError(errMsg("Bad request mentioning api key field"), 400)).toEqual({
      code: "PI_AI_ERROR",
      status: 400,
    });
    expect(classifyPiError(errMsg("Forbidden"), 401)).toEqual({ code: "AUTH", status: 401 });
    expect(classifyPiError(errMsg("Too many requests"), 429)).toEqual({ code: "RATE_LIMIT", status: 429 });
    expect(classifyPiError(errMsg("You exceeded your current quota (insufficient_quota)"), 429)).toEqual({
      code: "PI_AI_ERROR",
      status: 429,
    });
    expect(classifyPiError(errMsg("Cloudflare SSL handshake failed"), 525)).toEqual({ code: "SERVER", status: 525 });
    expect(classifyPiError(errMsg("request rate increased too quickly"))).toEqual({ code: "SERVER", status: 503 });
    expect(classifyPiError(errMsg("Provider returned an empty response"))).toEqual({ code: "SERVER", status: 503 });

    const quotaExhausted = { message: "insufficient_quota", code: "PI_AI_ERROR", status: 429 };
    expect(isRetryableLlmFailure(quotaExhausted)).toBe(false);
    expect(classifyLlmFailure(quotaExhausted)).toEqual({
      code: "model_error",
      message: "insufficient_quota",
      retryable: false,
    });

    const transient = { message: "upstream 525", code: "SERVER", status: 525 };
    expect(isRetryableLlmFailure(transient)).toBe(true);
    expect(classifyLlmFailure(transient)).toEqual({
      code: "model_error",
      message: "upstream 525",
      retryable: true,
    });
  });
});

agentApiConformance("dsh (sqlite)", dshSubject());
