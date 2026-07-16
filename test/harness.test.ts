import { describe, expect, it } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { inMemorySessionStore } from "../src/index.ts";
import { TOOL_ACTIVATION_ENTRY, piHarnessFactory, resolveHarnessActiveToolNames } from "../src/engines/pi/harness.ts";
import { makeFaux } from "./faux.ts";

const fakeTool = (name: string): AgentTool =>
  ({
    name,
    description: name,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
  }) as unknown as AgentTool;

describe("piHarnessFactory: provider retry wiring", () => {
  it("built harnesses carry maxRetries — the wiring retry-capable pi-ai adapters honor", async () => {
    // Retry-capable adapters (OpenAI-family / Anthropic / Azure / Codex) default to 0 retries —
    // this wiring enables their client-side retries (a transient `fetch failed` killed a whole
    // turn live in the 0.8.0 release verification). google / vertex / bedrock / mistral ignore
    // the option; transients there still fail the turn.
    const { faux, models } = makeFaux();
    const factory = piHarnessFactory({
      sessions: inMemorySessionStore(),
      env: new NodeExecutionEnv({ cwd: process.cwd() }),
      models,
      model: faux.getModel(),
      systemPrompt: "test",
    });
    const harness = await factory("s1");
    expect(harness.getStreamOptions().maxRetries).toBe(2);
  });
});

describe("piHarnessFactory: active-tool set restore (stateless invoke)", () => {
  // pi's harness writes active_tools_change to the session but its constructor never reads it back —
  // fine for pi's long-lived TUI harness, but fastagent builds a fresh harness per invoke: without the
  // restore, a session's active set silently resets to "all tools" on the next turn.
  it("a fresh harness reopens the session with its activation DELTAS layered on the initial set", async () => {
    const deferred = Object.assign(fakeTool("lazy"), { deferred: true });
    const { faux, models } = makeFaux();
    const sessions = inMemorySessionStore();
    const factory = piHarnessFactory({
      sessions,
      env: new NodeExecutionEnv({ cwd: process.cwd() }),
      models,
      model: faux.getModel(),
      tools: [fakeTool("alpha"), deferred],
      systemPrompt: "test",
    });
    const first = await factory("s1");
    expect(first.getActiveTools().map((t) => t.name)).toEqual(["alpha"]); // initial: non-deferred only
    // The dedicated delta entry the activation bridge writes (pi's own active_tools_change snapshot
    // is deliberately ignored by the resolve).
    await (await sessions.openOrCreate("s1")).appendCustomEntry(TOOL_ACTIVATION_ENTRY, { names: ["lazy"] });

    const second = await factory("s1"); // a fresh harness, as every invoke builds
    expect(second.getActiveTools().map((t) => t.name)).toEqual(["alpha", "lazy"]);
  });

  it("deltas, not snapshots: later-added tools join old sessions; a tool flipped to deferred drops out", async () => {
    const deferred = Object.assign(fakeTool("lazy"), { deferred: true });
    const { faux, models } = makeFaux();
    const sessions = inMemorySessionStore();
    const base = {
      sessions,
      env: new NodeExecutionEnv({ cwd: process.cwd() }),
      models,
      model: faux.getModel(),
      systemPrompt: "test",
    };
    await piHarnessFactory({ ...base, tools: [fakeTool("alpha"), deferred] })("s1");
    await (await sessions.openOrCreate("s1")).appendCustomEntry(TOOL_ACTIVATION_ENTRY, { names: ["lazy"] });

    // The workspace later adds "gamma" (joins — a snapshot would freeze it out) and flips "alpha" to
    // deferred (drops out — this session never DISCOVERED it; a snapshot would keep it active).
    const flippedAlpha = Object.assign(fakeTool("alpha"), { deferred: true });
    const second = await piHarnessFactory({ ...base, tools: [flippedAlpha, fakeTool("gamma"), deferred] })("s1");
    expect(
      second
        .getActiveTools()
        .map((t) => t.name)
        .sort(),
    ).toEqual(["gamma", "lazy"]);
  });

  it("a recorded activation that is no longer mounted is dropped instead of bricking the session", async () => {
    const deferred = Object.assign(fakeTool("lazy"), { deferred: true });
    const { faux, models } = makeFaux();
    const sessions = inMemorySessionStore();
    const base = {
      sessions,
      env: new NodeExecutionEnv({ cwd: process.cwd() }),
      models,
      model: faux.getModel(),
      systemPrompt: "test",
    };
    await piHarnessFactory({ ...base, tools: [fakeTool("alpha"), deferred] })("s1");
    await (await sessions.openOrCreate("s1")).appendCustomEntry(TOOL_ACTIVATION_ENTRY, { names: ["ghost"] });

    // The constructor throws on unknown names, so an unfiltered restore would fail every future invoke.
    const second = await piHarnessFactory({ ...base, tools: [fakeTool("alpha"), deferred] })("s1");
    expect(second.getActiveTools().map((t) => t.name)).toEqual(["alpha"]);
  });

  it("resolveHarnessActiveToolNames: null → default; union semantics; missing names dropped + warned", () => {
    const tools = [fakeTool("alpha")];
    expect(resolveHarnessActiveToolNames(null, tools, "s")).toBeUndefined(); // never changed → pi's default
    expect(resolveHarnessActiveToolNames(["alpha"], tools, "s")).toEqual(["alpha"]);
    // UNION semantics: a record contributes activations ON TOP of the initial set (which, with no
    // deferral, is all mounted tools) — it cannot narrow below it. The record's semantic on the
    // serving path is "which deferred tools this session activated", not a frozen snapshot.
    expect(resolveHarnessActiveToolNames([], tools, "s")).toEqual(["alpha"]);
    expect(resolveHarnessActiveToolNames(["ghost"], tools, "s")).toEqual(["alpha"]); // missing → dropped + warned

    const deferredTool = Object.assign(fakeTool("lazy"), { deferred: true });
    const withDeferred = [fakeTool("alpha"), deferredTool];
    expect(resolveHarnessActiveToolNames(null, withDeferred, "s")).toEqual(["alpha"]); // initial excludes deferred
    expect(resolveHarnessActiveToolNames(["lazy"], withDeferred, "s")).toEqual(["alpha", "lazy"]); // union
    expect(resolveHarnessActiveToolNames(["ghost"], withDeferred, "s2")).toEqual(["alpha"]);
  });
});

describe("piHarnessFactory: thinking-level wiring", () => {
  it("threads thinkingLevel to the harness (config.thinkingLevel is not a silent no-op)", async () => {
    const { faux, models } = makeFaux();
    const factory = piHarnessFactory({
      sessions: inMemorySessionStore(),
      env: new NodeExecutionEnv({ cwd: process.cwd() }),
      models,
      model: faux.getModel(),
      thinkingLevel: "high",
      systemPrompt: "test",
    });
    expect((await factory("s1")).getThinkingLevel()).toBe("high");
  });

  it('unset → fastagent\'s pinned default "medium" (pi TUI parity), not the bare harness\'s "off"', async () => {
    // The bare harness falls back to "off", but authors vibe in the pi TUI whose default is "medium" —
    // serving must match what they iterated with, and the pin means an upstream default change in
    // either place cannot silently alter deployments.
    const { faux, models } = makeFaux();
    const factory = piHarnessFactory({
      sessions: inMemorySessionStore(),
      env: new NodeExecutionEnv({ cwd: process.cwd() }),
      models,
      model: faux.getModel(),
      systemPrompt: "test",
    });
    expect((await factory("s1")).getThinkingLevel()).toBe("medium");
  });
});
