import { describe, expect, it } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { inMemorySessionStore } from "../src/index.ts";
import { piHarnessFactory, restoreActiveToolNames } from "../src/engines/pi/harness.ts";
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
  it("a fresh harness reopens the session with its recorded active set, not the default", async () => {
    const { faux, models } = makeFaux();
    const sessions = inMemorySessionStore();
    const factory = piHarnessFactory({
      sessions,
      env: new NodeExecutionEnv({ cwd: process.cwd() }),
      models,
      model: faux.getModel(),
      tools: [fakeTool("alpha"), fakeTool("beta")],
      systemPrompt: "test",
    });
    const first = await factory("s1");
    expect(first.getActiveTools().map((t) => t.name)).toEqual(["alpha", "beta"]); // default: all mounted
    await first.setActiveTools(["beta"]); // idle phase → persisted to the session immediately

    const second = await factory("s1"); // a fresh harness, as every invoke builds
    expect(second.getActiveTools().map((t) => t.name)).toEqual(["beta"]);
  });

  it("a recorded tool that is no longer mounted is dropped instead of bricking the session", async () => {
    const { faux, models } = makeFaux();
    const sessions = inMemorySessionStore();
    const base = {
      sessions,
      env: new NodeExecutionEnv({ cwd: process.cwd() }),
      models,
      model: faux.getModel(),
      systemPrompt: "test",
    };
    const first = await piHarnessFactory({ ...base, tools: [fakeTool("alpha"), fakeTool("beta")] })("s1");
    await first.setActiveTools(["alpha", "beta"]);

    // The workspace removed "alpha": the constructor throws on unknown names, so an unfiltered restore
    // would fail every future invoke of this session.
    const second = await piHarnessFactory({ ...base, tools: [fakeTool("beta")] })("s1");
    expect(second.getActiveTools().map((t) => t.name)).toEqual(["beta"]);
  });

  it("restoreActiveToolNames: null → default; intact [] restored as-is; filter-to-empty → default", () => {
    const tools = [fakeTool("alpha")];
    expect(restoreActiveToolNames(null, tools, "s")).toBeUndefined(); // never changed → pi's default
    expect(restoreActiveToolNames(["alpha"], tools, "s")).toEqual(["alpha"]);
    expect(restoreActiveToolNames([], tools, "s")).toEqual([]); // deliberate empty set → faithful
    expect(restoreActiveToolNames(["ghost"], tools, "s")).toBeUndefined(); // intent unhonorable → default
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
});
