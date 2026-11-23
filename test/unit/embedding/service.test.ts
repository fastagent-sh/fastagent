import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { registerSessionResourceCleanup } from "@earendil-works/pi-ai/session-resources";
import { obj } from "@earendil-works/pi-schema";
import { afterAll, describe, expect, it } from "vitest";
import { serveService } from "../../../packages/fastagent/src/cli/serve.ts";
import { DEFINITION_FORMAT, defineDefinition } from "../../../packages/fastagent/src/definition/definition.ts";
import { type ServingAgent, openAgent, openServing } from "../../../packages/fastagent/src/harnesses/serving.ts";
import { defineTool } from "../../../packages/fastagent/src/harnesses/tool.ts";
import { openSource } from "../../harnesses/open-source.ts";
import { fauxAgent } from "../../doubles/cli-run.ts";
import { loadSourceDefinition } from "../../../packages/fastagent/src/harnesses/assembly.ts";
import { connectAgent } from "../../../packages/client/src/http/client.ts";
import { type ServeOptions, serveAgent } from "../../../packages/fastagent/src/service.ts";
import { CODEX_MODEL } from "../../doubles/codex-model.ts";
import { NOT_HOSTED } from "../../../packages/fastagent/src/serving-command.ts";

const opened: ServingAgent[] = [];
afterAll(async () => {
  for (const agent of opened) await agent.close();
});

/** The directory opened as a serve opens it, with no storage of its own, and mounted. */
async function createAgentService(dir: string, options: ServeOptions = {}) {
  const served = await openServing(await loadSourceDefinition(dir), {
    secrets: {},
    env: {},
    ownEnv: process.env,
    runsAs: NOT_HOSTED,
    storage: "memory",
  });
  opened.push(served.agent);
  return serveAgent(served, options);
}

async function agentDir(files: Record<string, string> = {}, config = `{ model: "${CODEX_MODEL}" }`): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fa-surface-"));
  await writeFile(join(dir, "fastagent.config.ts"), `export default ${config};\n`);
  await writeFile(join(dir, "SYSTEM.md"), "You are a test agent.\n");
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), body);
  }
  return dir;
}

describe("serveAgent over an opened directory", () => {
  it("answers GET /health and nothing else outside the Agent API, which it serves only with a key", async () => {
    const service = await createAgentService(await agentDir());
    try {
      const health = await service.fetch(new Request("http://h/health"));
      expect([health.status, await health.json()]).toEqual([200, { status: "ok" }]);
      expect((await service.fetch(new Request("http://h/health", { method: "POST" }))).status).toBe(405);
      expect((await service.fetch(new Request("http://h/v1/info"))).status).toBe(404);
      expect(service.api).toBe(false);
    } finally {
      await service.close();
    }
  });
});

describe("openAgent: an agent directory opened in an app", () => {
  it("serves the Agent API under /v1 only with a key", async () => {
    const dir = await agentDir();
    const unkeyed = await openSource(dir);
    const plain = await unkeyed.serve();
    expect((await plain.fetch(new Request("http://app/v1/agent"))).status).toBe(404);
    await unkeyed.close();

    const keyed = await openSource(dir);
    const service = await keyed.serve({ apiKeys: ["k"] });
    const info = await service.fetch(new Request("http://app/v1/agent", { headers: { authorization: "Bearer k" } }));
    expect(await info.json()).toMatchObject({ name: expect.any(String) });
    expect((await service.fetch(new Request("http://app/v1/agent"))).status).toBe(401);
    expect((await service.fetch(new Request("http://app/health"))).status).toBe(200);
    await keyed.close();

    const watched = await openSource(dir);
    const listening = await watched.serve({ apiKeys: ["k"] });
    const port = await listening.listen(0, "127.0.0.1");
    const { id } = await watched.sessions.create();
    const events = connectAgent(`http://127.0.0.1:${port}`, { apiKey: "k" })
      .sessions.events(id)
      [Symbol.asyncIterator]();
    expect((await events.next()).value).toMatchObject({ type: "state" });
    // The same stream as bytes: one the server's grace cut would end in an error, not at its end.
    const raw = await fetch(`http://127.0.0.1:${port}/v1/sessions/${id}/events`, {
      headers: { authorization: "Bearer k" },
    });
    const reader = (raw.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let said = decoder.decode((await reader.read()).value);
    await watched.close();
    for (let read = await reader.read(); !read.done; read = await reader.read()) said += decoder.decode(read.value);
    expect(said).toContain("the service is closing");
    expect((await events.next()).value).toMatchObject({
      type: "stream_error",
      error: { code: "unavailable", message: "the service is closing" },
    });

    const unset = await openSource(dir);
    await expect(unset.serve({ apiKeys: [process.env.FASTAGENT_TEST_UNSET_KEY ?? ""] })).rejects.toThrow(
      "the Agent API needs at least one key, and no key may be empty",
    );
    await unset.close();
  });

  it("persists named conversations across restarts on SQLite via openAgent().invoke()", async () => {
    const dir = await fauxAgent("fa-emb-conv-");
    const first = await openSource(dir);
    const msg1 = await first.invoke({ conversation: "daily-digest", content: "run 1" }, { wait: 15 });
    expect(msg1).toMatchObject({ status: "completed", answer: { text: "seen 1" } });
    await first.close();

    const second = await openSource(dir);
    const msg2 = await second.invoke({ conversation: "daily-digest", content: "run 2" }, { wait: 15 });
    expect(msg2).toMatchObject({ status: "completed", sessionId: msg1.sessionId, answer: { text: "seen 2" } });
    await second.close();
  });

  it("reports not-ready on /health and ready() synchronously when harness close starts, before cleanup finishes", async () => {
    const dir = await agentDir();
    const root = await mkdtemp(join(tmpdir(), "fa-ready-timing-"));
    let markStarted!: () => void;
    const toolStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseCleanup!: () => void;
    const holdCleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const holdTool = defineTool({
      name: "hold_cleanup",
      description: "Holds an invocation open until the test releases cleanup.",
      parameters: obj({}),
      execute: async () => {
        markStarted();
        // Deliberately ignore abort so harness.close() blocks in beforeClose() until releaseCleanup() runs.
        await holdCleanup;
        return { output: [{ type: "text", text: "done" }] };
      },
    });
    const faux = fauxProvider({ provider: "gw", models: [{ id: "m1" }] });
    faux.setResponses([
      () => fauxAssistantMessage([fauxToolCall("hold_cleanup", {})], { stopReason: "toolUse" }),
      () => fauxAssistantMessage("done"),
    ]);
    const definition = defineDefinition({
      format: DEFINITION_FORMAT,
      builtWith: "0.0.0",
      name: "hold-test",
      version: "0.0.0",
      dir,
      config: { model: "gw/m1", providers: [faux.provider] },
      registry: {
        tools: [{ file: "src/tools/hold.ts", name: "hold", value: holdTool }],
        extensions: [],
      },
    });
    const agent = await openAgent(definition, { root });
    const service = await agent.serve({ apiKeys: ["k"] });
    const port = await service.listen(0, "127.0.0.1");
    const base = `http://127.0.0.1:${port}`;
    try {
      expect(agent.ready()).toBe(true);
      expect(service.ready()).toBe(true);
      const okHealth = await fetch(`${base}/health`);
      expect([okHealth.status, await okHealth.json()]).toEqual([200, { status: "ok" }]);
      expect((await fetch(`${base}/health`, { method: "HEAD" })).status).toBe(200);

      const session = await agent.sessions.create();
      void agent.messages.send({ sessionId: session.id, content: "hold" });
      await toolStarted;

      let harnessClosedSettled = false;
      let agentClosedSettled = false;
      void agent.harness?.closed.then(() => {
        harnessClosedSettled = true;
      });
      void agent.closed?.then(() => {
        agentClosedSettled = true;
      });

      // Initiate terminal runtime shutdown while the listener stays active and cleanup is still held open.
      const closePromise = agent.harness?.close(BACKGROUND_CONTEXT);

      // Observe not-ready BEFORE releasing cleanup and BEFORE closed settles.
      expect(harnessClosedSettled).toBe(false);
      expect(agentClosedSettled).toBe(false);
      expect(agent.ready()).toBe(false);
      expect(service.ready()).toBe(false);

      const badHealth = await fetch(`${base}/health`);
      expect([badHealth.status, await badHealth.json()]).toEqual([503, { status: "unavailable" }]);
      expect((await fetch(`${base}/health`, { method: "HEAD" })).status).toBe(503);

      const client = connectAgent(base, { apiKey: "k" });
      await expect(client.sessions.create()).rejects.toMatchObject({ code: "unavailable" });
      expect(harnessClosedSettled).toBe(false);
      expect(agentClosedSettled).toBe(false);

      releaseCleanup();
      await closePromise;
      await agent.closed;
      expect(harnessClosedSettled).toBe(true);
      expect(agentClosedSettled).toBe(true);
    } finally {
      releaseCleanup();
      await agent.close();
    }
  });

  it("releases only the closed agent's provider session resources without affecting another live agent, and preserves provider identity across reopen", async () => {
    const dir = await agentDir();
    const rootA = await mkdtemp(join(tmpdir(), "fa-prov-res-a-"));
    const rootB = await mkdtemp(join(tmpdir(), "fa-prov-res-b-"));
    const liveResources = new Set<string>();
    const cleanupCalls: Array<string | undefined> = [];
    const unregister = registerSessionResourceCleanup((sessionId) => {
      cleanupCalls.push(sessionId);
      if (sessionId === undefined) liveResources.clear();
      else liveResources.delete(sessionId);
    });

    const seenSessions: string[] = [];
    const faux = fauxProvider({ provider: "gw", models: [{ id: "m1" }] });
    faux.setResponses(
      Array.from({ length: 10 }, () => (_context, options) => {
        const providerSessionId = options?.sessionId;
        if (providerSessionId !== undefined) {
          seenSessions.push(providerSessionId);
          liveResources.add(providerSessionId);
        }
        return fauxAssistantMessage("ok");
      }),
    );
    const definition = defineDefinition({
      format: DEFINITION_FORMAT,
      builtWith: "0.0.0",
      name: "provider-res-test",
      version: "0.0.0",
      dir,
      config: { model: "gw/m1", providers: [faux.provider] },
      registry: { tools: [], extensions: [] },
    });

    let agentA: Awaited<ReturnType<typeof openAgent>> | undefined;
    let agentB: Awaited<ReturnType<typeof openAgent>> | undefined;
    let reopenedA: Awaited<ReturnType<typeof openAgent>> | undefined;
    try {
      agentA = await openAgent(definition, { root: rootA });
      agentB = await openAgent(definition, { root: rootB });

      const sA = await agentA.sessions.create();
      const sB = await agentB.sessions.create();
      expect((await agentA.messages.send({ sessionId: sA.id, content: "hi A" }, { wait: 15 })).status).toBe(
        "completed",
      );
      expect((await agentB.messages.send({ sessionId: sB.id, content: "hi B" }, { wait: 15 })).status).toBe(
        "completed",
      );

      const [providerIdA, providerIdB] = seenSessions;
      expect(providerIdA).toBeTypeOf("string");
      expect(providerIdB).toBeTypeOf("string");
      expect(providerIdA).not.toBe(providerIdB);
      expect(liveResources.has(providerIdA as string)).toBe(true);
      expect(liveResources.has(providerIdB as string)).toBe(true);

      // Closing agentA releases only agentA's provider session resource, never via global cleanup.
      await agentA.close();
      agentA = undefined;
      expect(cleanupCalls).not.toContain(undefined);
      expect(liveResources.has(providerIdA as string)).toBe(false);
      expect(liveResources.has(providerIdB as string)).toBe(true);

      // agentB remains live and functional.
      expect((await agentB.messages.send({ sessionId: sB.id, content: "still alive" }, { wait: 15 })).status).toBe(
        "completed",
      );
      await agentB.close();
      agentB = undefined;
      expect(liveResources.size).toBe(0);

      // Reopening agentA keeps its durable provider session ID and releases it again on close.
      reopenedA = await openAgent(definition, { root: rootA });
      expect((await reopenedA.messages.send({ sessionId: sA.id, content: "after reopen" }, { wait: 15 })).status).toBe(
        "completed",
      );
      expect(seenSessions.at(-1)).toBe(providerIdA);
      expect(liveResources.has(providerIdA as string)).toBe(true);
      await reopenedA.close();
      reopenedA = undefined;
      expect(liveResources.size).toBe(0);
    } finally {
      await agentA?.close().catch(() => undefined);
      await agentB?.close().catch(() => undefined);
      await reopenedA?.close().catch(() => undefined);
      unregister();
    }
  });
});

describe("standalone serveService lifecycle", () => {
  it("stops serving, withdraws owner, and exits non-zero on unexpected runtime shutdown", async () => {
    const dir = await agentDir();
    const stateRoot = await mkdtemp(join(tmpdir(), "fa-standalone-unexpected-"));
    const served = await openServing(await loadSourceDefinition(dir), {
      secrets: {},
      env: {},
      ownEnv: process.env,
      runsAs: NOT_HOSTED,
      storage: "memory",
    });
    const service = await serveAgent(served, { apiKeys: ["k"] });
    const signals = new Map<NodeJS.Signals, () => void>();
    let resolveListening!: (port: number) => void;
    const listening = new Promise<number>((resolve) => {
      resolveListening = resolve;
    });
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });

    serveService(
      service,
      { port: 0, host: "127.0.0.1" },
      { stateRoot, key: "k" },
      {
        exit: (code) => resolveExit(code),
        registerSignal: (signal, handler) => {
          signals.set(signal, handler);
          return () => signals.delete(signal);
        },
        onListening: (port) => resolveListening(port),
      },
    );

    const port = await listening;
    const base = `http://127.0.0.1:${port}`;
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect(existsSync(join(stateRoot, "owner.json"))).toBe(true);

    // Unexpected terminal runtime shutdown (same path as storage lease loss closing the harness).
    await served.agent.harness?.close(BACKGROUND_CONTEXT);
    expect(await exited).toBe(1);
    expect(existsSync(join(stateRoot, "owner.json"))).toBe(false);
    expect(signals.size).toBe(0);
    await expect(fetch(`${base}/health`)).rejects.toThrow(/fetch failed|ECONNREFUSED/);
    await served.agent.close();
  });

  it("ignores transient model errors, missing credentials, and client disconnects, then exits 0 on SIGTERM", async () => {
    const dir = await agentDir();
    const faux = fauxProvider({ provider: "gw", models: [{ id: "m1" }] });
    faux.setResponses([
      () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 the model is overloaded" }),
      () => fauxAssistantMessage("recovered"),
      () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "The model refused the request" }),
    ]);
    const definition = defineDefinition({
      format: DEFINITION_FORMAT,
      builtWith: "0.0.0",
      name: "resilient-test",
      version: "0.0.0",
      dir,
      config: { model: "gw/m1", providers: [faux.provider] },
      registry: { tools: [], extensions: [] },
    });
    const served = await openServing(definition, {
      secrets: {},
      env: {},
      ownEnv: process.env,
      runsAs: NOT_HOSTED,
      storage: "memory",
    });
    const service = await serveAgent(served, { apiKeys: ["k"] });
    const signals = new Map<NodeJS.Signals, () => void>();
    let resolveListening!: (port: number) => void;
    const listening = new Promise<number>((resolve) => {
      resolveListening = resolve;
    });
    const exitCodes: number[] = [];
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });

    serveService(service, { port: 0, host: "127.0.0.1" }, undefined, {
      exit: (code) => {
        exitCodes.push(code);
        resolveExit(code);
      },
      registerSignal: (signal, handler) => {
        signals.set(signal, handler);
        return () => signals.delete(signal);
      },
      onListening: (port) => resolveListening(port),
    });

    const port = await listening;
    const base = `http://127.0.0.1:${port}`;
    const client = connectAgent(base, { apiKey: "k" });

    // 1) Transient 503 model error (retries and recovers) + permanent model error (fails without crashing runtime)
    const s1 = await client.sessions.create();
    const mTransient = await client.messages.send({ sessionId: s1.id, content: "flaky" }, { wait: 15 });
    expect(mTransient.status).toBe("completed");
    expect(mTransient.answer?.text).toBe("recovered");

    const mRefused = await client.messages.send({ sessionId: s1.id, content: "fail" }, { wait: 15 });
    expect(mRefused.status).toBe("failed");

    // 2) Missing model credentials (auth_required)
    const s2 = await client.sessions.create({ model: { provider: "openai", modelId: "gpt-5.4" } });
    const m2 = await client.messages.send({ sessionId: s2.id, content: "no key" }, { wait: 15 });
    expect(m2.status).toBe("failed");
    expect(m2.error?.code).toBe("auth_required");

    // 3) Client disconnect from an active SSE stream
    const ac = new AbortController();
    const sse = await fetch(`${base}/v1/sessions/${s1.id}/events`, {
      headers: { authorization: "Bearer k" },
      signal: ac.signal,
    });
    const reader = (sse.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    ac.abort();
    await reader.cancel().catch(() => undefined);

    // Runtime remains healthy and never triggers an unexpected process exit.
    expect(exitCodes).toEqual([]);
    expect(service.ready()).toBe(true);
    expect(served.agent.ready?.()).toBe(true);
    const stillOk = await fetch(`${base}/health`);
    expect([stillOk.status, await stillOk.json()]).toEqual([200, { status: "ok" }]);

    // 4) Intentional shutdown via SIGTERM exits 0 and closes the listener.
    signals.get("SIGTERM")?.();
    expect(await exited).toBe(0);
    expect(exitCodes).toEqual([0]);
    await expect(fetch(`${base}/health`)).rejects.toThrow(/fetch failed|ECONNREFUSED/);
    await served.agent.close();
  });

  it("exits 1 without listening when runtime is already stopped, and exits 0 when SIGTERM arrives mid-listen", async () => {
    const dir = await agentDir();
    const stopped = await openServing(await loadSourceDefinition(dir), {
      secrets: {},
      env: {},
      ownEnv: process.env,
      runsAs: NOT_HOSTED,
      storage: "memory",
    });
    const stoppedService = await serveAgent(stopped, { apiKeys: ["k"] });
    await stopped.agent.harness?.close(BACKGROUND_CONTEXT);

    let listened = false;
    const stoppedExit = new Promise<number>((resolve) => {
      serveService(stoppedService, { port: 0, host: "127.0.0.1" }, undefined, {
        exit: resolve,
        registerSignal: () => () => {},
        onListening: () => {
          listened = true;
        },
      });
    });
    expect(await stoppedExit).toBe(1);
    expect(listened).toBe(false);
    await stopped.agent.close();

    // SIGTERM arriving before listen settles must still exit 0 even though listen rejects on close.
    const racing = await openServing(await loadSourceDefinition(dir), {
      secrets: {},
      env: {},
      ownEnv: process.env,
      runsAs: NOT_HOSTED,
      storage: "memory",
    });
    const racingService = await serveAgent(racing, { apiKeys: ["k"] });
    const signals = new Map<NodeJS.Signals, () => void>();
    const racingExit = new Promise<number>((resolve) => {
      serveService(racingService, { port: 0, host: "127.0.0.1" }, undefined, {
        exit: resolve,
        registerSignal: (signal, handler) => {
          signals.set(signal, handler);
          return () => signals.delete(signal);
        },
      });
    });
    signals.get("SIGTERM")?.();
    expect(await racingExit).toBe(0);
    await racing.agent.close();
  });
});
