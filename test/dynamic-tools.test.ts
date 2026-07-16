import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { AgentEvent } from "../src/agent.ts";
import { piBasePrompt } from "../src/engines/pi/create.ts";
import { piHarnessFactory } from "../src/engines/pi/harness.ts";
import { createPiAgentFromHarness } from "../src/engines/pi/invoke.ts";
import { makeSearchToolsTool, withSearchTool } from "../src/engines/pi/search-tools.ts";
import { defineTool, isDeferredTool } from "../src/engines/pi/tool.ts";
import { inMemorySessionStore } from "../src/index.ts";
import { makeFaux } from "./faux.ts";

const weather = () =>
  defineTool({
    name: "lookup_weather",
    description: "Look up the current weather forecast for a city",
    input: z.object({ city: z.string() }),
    deferred: true,
    execute: ({ city }) => `Weather for ${city}: sunny`,
  });

const echo = () =>
  defineTool({
    name: "echo",
    description: "Echo a value",
    input: z.object({ value: z.string() }),
    execute: ({ value }) => value,
  });

describe("deferred tools: marker + mounting + prompt", () => {
  it("defineTool({ deferred }) marks the tool; withSearchTool mounts the loader only when needed", () => {
    expect(isDeferredTool(weather())).toBe(true);
    expect(isDeferredTool(echo())).toBe(false);

    // No deferred tool → untouched (today's agents never see search_tools).
    const plain = [echo()];
    expect(withSearchTool(plain)).toBe(plain);
    // Deferred tool → loader appended; idempotent; an author-defined search_tools wins.
    const mounted = withSearchTool([echo(), weather()]);
    expect(mounted.map((t) => t.name)).toContain("search_tools");
    expect(withSearchTool(mounted)).toBe(mounted);
    const authored = defineTool({
      name: "search_tools",
      description: "my own loader",
      input: z.object({}),
      execute: () => "mine",
    });
    const kept = withSearchTool([weather(), authored]);
    expect(kept.filter((t) => t.name === "search_tools")).toHaveLength(1);
    expect(kept.find((t) => t.name === "search_tools")?.description).toBe("my own loader");
  });

  it("an authored search_tools marked deferred keeps the loader ACTIVE (a deferred loader would strand every deferred tool)", () => {
    // The loader is the only entry point to the deferred tools — deferring it means nothing could ever
    // activate anything: silent, permanent capability loss. The marker is ignored (and warned about).
    const deferredLoader = defineTool({
      name: "search_tools",
      description: "my own loader",
      input: z.object({}),
      deferred: true,
      execute: () => "mine",
    });
    const mounted = withSearchTool([weather(), deferredLoader]);
    const loader = mounted.find((t) => t.name === "search_tools");
    expect(loader?.description).toBe("my own loader"); // still the author's — no builtin swapped in
    expect(loader && isDeferredTool(loader)).toBe(false); // marker stripped → in the initial active set
  });

  it("piBasePrompt lists only non-deferred tools + a discovery note, so activation never changes the prompt", () => {
    const tools = withSearchTool([echo(), weather()]);
    const prompt = piBasePrompt({ tools });
    expect(prompt).toContain("- echo:");
    expect(prompt).toContain("- search_tools:");
    expect(prompt).not.toContain("lookup_weather"); // its schema is not in the request until activated
    expect(prompt).toMatch(/1 additional tool\(s\) are registered but inactive/);
    expect(piBasePrompt({ tools: [echo()] })).not.toMatch(/registered but inactive/);
  });
});

describe("deferred tools: end-to-end through invoke (faux model)", () => {
  function makeAgent(
    responses: Parameters<ReturnType<typeof makeFaux>["faux"]["setResponses"]>[0],
    sessions = inMemorySessionStore(),
  ) {
    const { faux, models } = makeFaux();
    faux.setResponses(responses);
    const factory = piHarnessFactory({
      sessions,
      env: new NodeExecutionEnv({ cwd: process.cwd() }),
      models,
      model: faux.getModel(),
      tools: withSearchTool([echo(), weather()]),
      systemPrompt: "test",
    });
    return { agent: createPiAgentFromHarness({ harnessFactory: factory }), factory };
  }

  it("a deferred tool starts inactive; search_tools activates it and stamps addedToolNames; the next turn's fresh harness keeps it active", async () => {
    const sessions = inMemorySessionStore();
    const { agent, factory } = makeAgent(
      [
        fauxAssistantMessage(fauxToolCall("search_tools", { query: "weather forecast" }, { id: "c1" })),
        fauxAssistantMessage("found it"),
      ],
      sessions,
    );

    // Fresh session: deferred tool NOT active.
    expect((await factory("s1")).getActiveTools().map((t) => t.name)).toEqual(["echo", "search_tools"]);

    const events: AgentEvent[] = [];
    for await (const e of agent.invoke({ session: "s1" }, { text: "what's the weather?" })) events.push(e);
    expect(events.at(-1)?.type).toBe("completed");

    // The loader's tool result reports the activation to the model…
    const ended = events.find((e) => e.type === "tool_ended") as Extract<AgentEvent, { type: "tool_ended" }>;
    expect(JSON.stringify(ended.content)).toContain("lookup_weather");

    // …the session recorded the activation with the load point (addedToolNames on the toolResult)…
    const { messages } = await (await sessions.openOrCreate("s1")).buildContext();
    const toolResult = messages.find((m) => (m as { role?: string }).role === "toolResult") as {
      addedToolNames?: string[];
    };
    expect(toolResult.addedToolNames).toEqual(["lookup_weather"]);

    // …and the NEXT turn's fresh harness restores it (stateless invoke keeps the activation).
    expect((await factory("s1")).getActiveTools().map((t) => t.name)).toEqual([
      "echo",
      "search_tools",
      "lookup_weather",
    ]);
  });

  it("parallel batch: two search_tools calls — addedToolNames lands on the activating call only, the other reports already-active", async () => {
    // pi executes a batch's tool calls in parallel; the stamp must come from each execute's OWN
    // activate() calls, not an active-set snapshot diff (which would stamp a sibling's activation).
    const sessions = inMemorySessionStore();
    const { agent } = makeAgent(
      [
        fauxAssistantMessage([
          fauxToolCall("search_tools", { query: "weather" }, { id: "c1" }),
          fauxToolCall("search_tools", { query: "forecast" }, { id: "c2" }),
        ]),
        fauxAssistantMessage("done"),
      ],
      sessions,
    );

    const events: AgentEvent[] = [];
    for await (const e of agent.invoke({ session: "s3" }, { text: "weather?" })) events.push(e);
    expect(events.at(-1)?.type).toBe("completed");

    const { messages } = await (await sessions.openOrCreate("s3")).buildContext();
    const results = messages.filter((m) => (m as { role?: string }).role === "toolResult") as Array<{
      addedToolNames?: string[];
      content: Array<{ text?: string }>;
    }>;
    expect(results).toHaveLength(2);
    // Exactly ONE result carries the stamp — the call that actually activated the tool.
    const stamped = results.filter((r) => r.addedToolNames !== undefined);
    expect(stamped).toHaveLength(1);
    expect(stamped[0]?.addedToolNames).toEqual(["lookup_weather"]);
    // The other reports the truth (already active), never an empty "Activated: ." claim.
    const texts = results.map((r) => r.content[0]?.text ?? "");
    expect(texts.some((t) => /already active/.test(t))).toBe(true);
    expect(texts.some((t) => /Activated: \./.test(t))).toBe(false);
  });

  it("no keyword match → reports the inactive catalog instead of activating anything", async () => {
    const { agent, factory } = makeAgent([
      fauxAssistantMessage(fauxToolCall("search_tools", { query: "quantum chess" }, { id: "c1" })),
      fauxAssistantMessage("ok"),
    ]);

    const events: AgentEvent[] = [];
    for await (const e of agent.invoke({ session: "s2" }, { text: "go" })) events.push(e);
    const ended = events.find((e) => e.type === "tool_ended") as Extract<AgentEvent, { type: "tool_ended" }>;
    expect(JSON.stringify(ended.content)).toMatch(/No tools matched .*lookup_weather/);
    expect((await factory("s2")).getActiveTools().map((t) => t.name)).toEqual(["echo", "search_tools"]);
  });

  it("a broad query over the activation cap activates NOTHING and asks for a narrower query", async () => {
    // Activation is additive, session-persisted, and has no deactivate path — one broad token must
    // not permanently activate the catalog.
    const many = Array.from({ length: 6 }, (_, i) =>
      defineTool({
        name: `fetch_${i}`,
        description: `Fetch resource kind ${i}`,
        input: z.object({}),
        deferred: true,
        execute: () => "ok",
      }),
    );
    const { faux, models } = makeFaux();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("search_tools", { query: "fetch" }, { id: "c1" })),
      fauxAssistantMessage("ok"),
    ]);
    const factory = piHarnessFactory({
      sessions: inMemorySessionStore(),
      env: new NodeExecutionEnv({ cwd: process.cwd() }),
      models,
      model: faux.getModel(),
      tools: withSearchTool(many),
      systemPrompt: "test",
    });
    const agent = createPiAgentFromHarness({ harnessFactory: factory });
    const events: AgentEvent[] = [];
    for await (const e of agent.invoke({ session: "s4" }, { text: "go" })) events.push(e);
    const ended = events.find((e) => e.type === "tool_ended") as Extract<AgentEvent, { type: "tool_ended" }>;
    expect(JSON.stringify(ended.content)).toMatch(/too many to activate at once/);
    expect((await factory("s4")).getActiveTools().map((t) => t.name)).toEqual(["search_tools"]); // nothing activated
  });

  it("a query matching an ALREADY-ACTIVE tool says so — never 'No tools matched' (capability-missing trap)", async () => {
    // Long conversations forget what they activated; the loader is the only discovery surface, so it
    // must answer for the whole catalog, not only the inactive slice.
    const sessions = inMemorySessionStore();
    const { agent } = makeAgent(
      [
        fauxAssistantMessage(fauxToolCall("search_tools", { query: "echo" }, { id: "c1" })), // echo is ACTIVE
        fauxAssistantMessage("ok"),
      ],
      sessions,
    );
    const events: AgentEvent[] = [];
    for await (const e of agent.invoke({ session: "s5" }, { text: "go" })) events.push(e);
    const ended = events.find((e) => e.type === "tool_ended") as Extract<AgentEvent, { type: "tool_ended" }>;
    const text = JSON.stringify(ended.content);
    expect(text).toMatch(/Already active \(call directly\): echo/);
    expect(text).not.toMatch(/No tools matched/);
  });

  it("stamping copies the result — an author's frozen result object survives an activating call", async () => {
    const frozen = Object.freeze({ content: [{ type: "text", text: "done" }], details: {} });
    const loader = defineTool({
      name: "my_loader",
      description: "activates the weather tool",
      input: z.object({}),
      async execute(_input, ctx) {
        await ctx.tools?.activate(["lookup_weather"]);
        return frozen; // shared/frozen result — legal per the defineTool contract
      },
    });
    const { faux, models } = makeFaux();
    faux.setResponses([fauxAssistantMessage(fauxToolCall("my_loader", {}, { id: "c1" })), fauxAssistantMessage("ok")]);
    const sessions = inMemorySessionStore();
    const factory = piHarnessFactory({
      sessions,
      env: new NodeExecutionEnv({ cwd: process.cwd() }),
      models,
      model: faux.getModel(),
      tools: [loader, weather()],
      systemPrompt: "test",
    });
    const agent = createPiAgentFromHarness({ harnessFactory: factory });
    const events: AgentEvent[] = [];
    for await (const e of agent.invoke({ session: "s6" }, { text: "go" })) events.push(e);
    expect(events.at(-1)?.type).toBe("completed"); // no throw on the frozen object
    expect((frozen as { addedToolNames?: string[] }).addedToolNames).toBeUndefined(); // untouched
    const { messages } = await (await sessions.openOrCreate("s6")).buildContext();
    const toolResult = messages.find((m) => (m as { role?: string }).role === "toolResult") as {
      addedToolNames?: string[];
    };
    expect(toolResult.addedToolNames).toEqual(["lookup_weather"]); // the stamped COPY reached the session
  });

  it("search_tools outside a turn (bare `fastagent tool` run) degrades with a clear message", async () => {
    const tool = makeSearchToolsTool() as unknown as {
      execute: (id: string, params: unknown) => Promise<{ content: Array<{ text?: string }> }>;
    };
    const result = await tool.execute("cli", { query: "weather" });
    expect(result.content[0]?.text).toMatch(/unavailable outside a conversation turn/);
  });
});
