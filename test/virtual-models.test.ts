import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { collect } from "../src/protocol-collect.ts";
import { availableModelsFromDir, createPiAgentFromDir } from "../src/harnesses/pi/open.ts";
import { makeFaux } from "./faux.ts";

const directories: string[] = [];
const keys: string[] = [];
afterEach(async () => {
  for (const key of keys.splice(0)) delete (globalThis as Record<string, unknown>)[key];
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function routedAgent() {
  const dir = await mkdtemp(join(tmpdir(), "fa-virtual-model-"));
  directories.push(dir);
  const key = `__fa_router_${keys.length}_${Date.now()}`;
  keys.push(key);
  const { faux } = makeFaux({
    models: [
      { id: "small", contextWindow: 32000 },
      { id: "large", contextWindow: 64000 },
    ],
  });
  faux.setResponses(
    Array.from({ length: 12 }, () => (_context, _options, _state, model) => ({
      ...fauxAssistantMessage("routed answer"),
      provider: model.provider,
      model: model.id,
      api: model.api,
    })),
  );
  let arrivals = 0;
  let release: () => void;
  const bothBound = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state = {
    faux,
    concurrent: true,
    async beforePrompt() {
      if (!state.concurrent) return;
      if (++arrivals === 2) release();
      await bothBound;
    },
  };
  (globalThis as Record<string, unknown>)[key] = state;
  await mkdir(join(dir, "extensions"));
  await writeFile(join(dir, "fastagent.config.ts"), `export default { model: "router/auto" };`);
  await writeFile(
    join(dir, "extensions/router.ts"),
    `
const probe = globalThis[${JSON.stringify(key)}];
export default pi => {
  pi.registerProvider(probe.faux.provider);
  pi.on("before_agent_start", () => probe.beforePrompt());
  pi.registerVirtualModel({
    provider: "router", id: "auto", name: "Automatic", contextWindow: 8000,
    thinkingLevels: ["off", "high"],
    route(request, ctx) {
      const owner = ctx.sessionManager.getSessionId();
      const user = request.messages.filter(m => m.role === "user").at(-1);
      if (JSON.stringify(user?.content).includes("fail")) throw new Error("router refused this request");
      const id = JSON.stringify(user?.content).includes("large") ? "large" : "small";
      return { model: ctx.modelRegistry.find("faux", id), thinkingLevel: "off",
        state: { owner, count: (request.state?.count ?? 0) + 1 } };
    },
  });
};`,
  );
  const opened = await createPiAgentFromDir(dir);
  return { ...opened, dir, state };
}

function routerState(record: { getBranch(): unknown[] }) {
  return record
    .getBranch()
    .filter((entry) => (entry as { customType?: string }).customType === "pi.virtual-model-state")
    .at(-1) as { data: { state: { owner: string; count: number } } };
}

describe("Pi virtual models", () => {
  it("resolves extension models before startup, lists them, and isolates simultaneous routing contexts", async () => {
    const opened = await routedAgent();
    // Described as the extension declares it, the same in both listings.
    const auto = { spec: "router/auto", name: "Automatic", thinkingLevels: ["off", "high"], contextWindow: 8000 };
    expect(await opened.agent.models()).toContainEqual(auto);
    expect(await availableModelsFromDir(opened.dir)).toContainEqual(auto);
    expect(await opened.models.authStatus("router", "auto")).toMatchObject({ source: "virtual" });
    const results = await Promise.all([
      collect(opened.agent.invoke({ sessionId: "A", prompt: { text: "small" } })),
      collect(opened.agent.invoke({ sessionId: "B", prompt: { text: "large" } })),
    ]);
    expect(results.map((result) => result.text)).toEqual(["routed answer", "routed answer"]);
    opened.state.concurrent = false;
    for (const [id, physical, window] of [
      ["A", "small", 32000],
      ["B", "large", 64000],
    ] as const) {
      const record = await opened.sessions.openOrCreate(id);
      expect(routerState(record).data.state).toEqual({ owner: record.getSessionId(), count: 1 });
      const answer = record
        .buildSessionContext()
        .messages.filter((message) => message.role === "assistant")
        .at(-1);
      expect(answer).toMatchObject({ provider: "faux", model: physical });
      expect(await opened.agent.sessions.get(id).read({ limit: 0 })).toMatchObject({
        state: { model: "router/auto", thinkingLevels: ["off", "high"], context: { window } },
      });
    }
    // B is disposed before A runs again: no disposed router or captured context remains in A's runtime.
    await collect(opened.agent.invoke({ sessionId: "A", prompt: { text: "small again" } }));
    expect(routerState(await opened.sessions.openOrCreate("A")).data.state.count).toBe(2);
    const restarted = await createPiAgentFromDir(opened.dir);
    await collect(restarted.agent.invoke({ sessionId: "A", prompt: { text: "small after restart" } }));
    expect(routerState(await restarted.sessions.openOrCreate("A")).data.state.count).toBe(3);
    const read = await restarted.agent.sessions.get("A").read({ limit: 0 });
    const at = read.ok ? read.state.leafEntryId : undefined;
    expect(
      await restarted.agent.sessions.create({ sessionId: "fork", fork: { sessionId: "A", entryId: at as string } }),
    ).toEqual({ ok: true, sessionId: "fork" });
    await collect(restarted.agent.invoke({ sessionId: "fork", prompt: { text: "small fork" } }));
    const fork = await restarted.sessions.openOrCreate("fork");
    expect(routerState(fork).data.state).toEqual({ owner: fork.getSessionId(), count: 4 });
  });

  it("applies virtual selections and reports router failures as a failed run", async () => {
    const opened = await routedAgent();
    opened.state.concurrent = false;
    const say = (text: string) => collect(opened.agent.invoke({ sessionId: "s", prompt: { text } }));
    await say("small");
    const handle = opened.agent.sessions.get("s");
    const state = async () => {
      const read = await handle.read({ limit: 0 });
      if (!read.ok) throw new Error(read.error.message);
      return read.state;
    };
    expect(await handle.update({ model: "faux/large" })).toEqual({ ok: true });
    await say("physical");
    expect((await state()).model).toBe("faux/large");
    expect(await handle.update({ model: "router/auto", thinkingLevel: "high" })).toEqual({ ok: true });
    await say("large");
    expect(await state()).toMatchObject({ model: "router/auto", thinkingLevel: "high" });
    await expect(say("fail")).rejects.toMatchObject({
      outcome: { status: "failed", error: { message: expect.stringContaining("router refused this request") } },
    });
  });
});
