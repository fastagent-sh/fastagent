/**
 * A definition assembled onto pi-durable: the definition as a value, its declared secrets, the text read per request
 * (SYSTEM.md, AGENTS.md, skills loaded as pi loads them, prompt templates), and the code built with its secrets.
 */
import { readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { modelsOver } from "../../../packages/fastagent/src/harnesses/models/models.ts";
import {
  InMemoryCredentialStore,
  type TranscriptContext,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentSystemPrompt,
} from "@earendil-works/pi-ai";
import * as EffectSchema from "effect/Schema";
import { MemoryStorage, type ToolRegistration, createRegistry, defineTask, wrapTool } from "@earendil-works/pi-durable";
import {
  type ToolExecutionApi,
  defineTool as defineFastAgentTool,
  sessionIdOf,
} from "../../../packages/fastagent/src/harnesses/tool.ts";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { type DurableAgent, openDurableAgent } from "../../../packages/fastagent/src/harnesses/pi-durable/agent.ts";
import { DEFINITION_FORMAT, defineDefinition } from "../../../packages/fastagent/src/definition/definition.ts";
import { buildDefinition, loadSourceDefinition } from "../../../packages/fastagent/src/harnesses/assembly.ts";
import { type AssembleAgentOptions, assembleAgent } from "../../../packages/fastagent/src/harnesses/pi-durable/open.ts";
import type { LocalAgent } from "../../../packages/fastagent/src/harnesses/serving.ts";
import { openLockedStorage } from "../../../packages/fastagent/src/harnesses/pi-durable/storage.ts";
import { log } from "../../../packages/fastagent/src/log.ts";
import { NOT_HOSTED } from "../../../packages/fastagent/src/serving-command.ts";
import { openSource } from "../../harnesses/open-source.ts";
import {
  made,
  agentPackage,
  FILES,
  ENV,
  toolCall,
  lastToolResult,
  WITH_SESSION_TOOL,
} from "../../fixtures/durable-definition-fixtures.ts";

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

describe("an agent definition on pi-durable", () => {
  it("registers each module of src/ by its default export, tests left out, in file order, writing nothing", async () => {
    const dir = agentPackage(FILES);
    const before = readdirSync(dir, { recursive: true }).sort();
    const { registry } = await loadSourceDefinition(dir);
    expect(registry.tools.map(({ file }) => file)).toEqual(["src/tools/weather.ts"]);
    expect(readdirSync(dir, { recursive: true }).sort()).toEqual(before);
  });

  it("refuses to run while a required secret has no value, naming where it is declared, and not for an optional one", async () => {
    const definition = await loadSourceDefinition(agentPackage(FILES));
    expect(() => buildDefinition(definition, { GH_TOKEN: "gh" })).toThrow(
      "missing required secrets: WEATHER_KEY (src/tools/weather.ts)",
    );
    const built = buildDefinition(definition, ENV);
    expect(built.tools.map((tool) => tool.name)).toEqual(["weather"]);
  });

  describe("opened", () => {
    const opened: DurableAgent[] = [];
    afterAll(async () => {
      for (const agent of opened) await agent.close();
    });

    async function open(files = FILES, options: Partial<AssembleAgentOptions> = {}, opening = (dir: string) => dir) {
      const dir = agentPackage(files);
      const definition = await loadSourceDefinition(opening(dir));
      const { faux } = (await import(join(dir, "model.ts"))) as { faux: ReturnType<typeof fauxProvider> };
      const code = buildDefinition(definition, ENV);
      const agent = await assembleAgent(definition, {
        storage: new MemoryStorage(),
        runsAs: NOT_HOSTED,
        processEnv: {},
        models: modelsOver(new InMemoryCredentialStore(), code.providers),
        code,
        ...options,
      });
      opened.push(agent);
      return { dir, agent, faux };
    }

    async function ask(agent: DurableAgent, text: string) {
      return agent.messages.send({ sessionId: (await agent.sessions.create()).id, content: text }, { wait: 30 });
    }

    it("renders SYSTEM.md, AGENTS.md, and the skills it may load, read for each request", async () => {
      const { dir, agent, faux } = await open();
      const prompts: string[] = [];
      faux.setResponses(
        [1, 2].map(() => (context: TranscriptContext) => {
          prompts.push(getCurrentSystemPrompt(context.messages));
          return fauxAssistantMessage("ok");
        }),
      );
      await ask(agent, "hi");
      writeFileSync(join(dir, "SYSTEM.md"), "You are Support, version two.\n");
      await ask(agent, "again");
      const [first, second] = prompts as [string, string];
      expect(first.startsWith("You are Support.")).toBe(true);
      expect(first).toContain("<project_context>\nBe brief.\n</project_context>");
      expect(first).toContain("<name>lookup-order</name>");
      expect(first).toContain(`<location>${join(dir, "skills/lookup-order/SKILL.md")}</location>`);
      expect(first).not.toContain("Not_Valid");
      expect(second.startsWith("You are Support, version two.")).toBe(true);
    });

    it("runs its tool with the secret it declared, an unset optional one absent", async () => {
      const { agent, faux } = await open();
      faux.setResponses([
        () => toolCall("weather", { city: "London" }),
        (context) => fauxAssistantMessage(lastToolResult(context)),
      ]);
      expect((await ask(agent, "weather?")).answer?.text).toBe("London: sunny (key k-123, region none)");
    });

    it("tells a tool the session it is called in, as the Agent hands it out", async () => {
      const { agent, faux } = await open(WITH_SESSION_TOOL);
      faux.setResponses([() => toolCall("whoami", {}), (context) => fauxAssistantMessage(lastToolResult(context))]);
      const sessionId = (await agent.sessions.create()).id;
      const sent = await agent.messages.send({ sessionId, content: "where?" }, { wait: 30 });
      expect(sent.answer?.text).toBe(`session ${sessionId}`);
    });

    it("offers its prompt templates and skills as commands, expanded for the model and kept as sent", async () => {
      const { dir, agent, faux } = await open();
      // A skill linked in from elsewhere whose target is gone is skipped, not a failure of every request.
      symlinkSync(join(dir, "nowhere"), join(dir, "skills/ghost"));
      expect(await agent.info()).toMatchObject({
        name: "support",
        commands: [
          { name: "review", description: "Review something" },
          { name: "skill:lookup-order", description: "Look an order up. Use when a customer names an order." },
        ],
      });
      const seen: string[] = [];
      faux.setResponses(
        [1, 2].map(() => (context: TranscriptContext) => {
          const last = context.messages.at(-1);
          seen.push(typeof last?.content === "string" ? last.content : JSON.stringify(last?.content));
          return fauxAssistantMessage("ok");
        }),
      );
      await ask(agent, '/review "the plan" twice');
      await ask(agent, "/skill:lookup-order order 7");
      expect(seen[0]).toContain("Review the plan carefully. Everything: the plan twice");
      expect(seen[1]).toContain('<skill name=\\"lookup-order\\"');
      expect(seen[1]).toContain("Ask for the order number");
      expect(seen[1]).toContain("order 7");
    });

    const offered = async (agent: DurableAgent) => {
      const created = await agent.sessions.create();
      const conversation = await agent.conversation(created.id);
      if (conversation === undefined) throw new Error("the new session has no conversation");
      return (await conversation.agent(BACKGROUND_CONTEXT)).tools.map(({ name }) => name);
    };

    it("codingTools: false disables read/write/edit/bash, refuses enabling them on a session, and omits workspace and skills prompts even with a custom read tool", async () => {
      const noCoding = {
        ...FILES,
        "fastagent.config.ts": `import { faux } from "./model.ts";
export default { model: "fixture/m", thinkingLevel: "low", codingTools: false, providers: [faux.provider] };
`,
        "src/tools/read.ts": `import { defineTool } from "@fastagent-sh/fastagent";
export default defineTool({
  name: "read",
  description: "Read a CRM record",
  parameters: { type: "object", properties: {} } as const,
  execute: async () => ({ output: [{ type: "text", text: "record" }] }),
});
`,
      };
      const { dir, agent, faux } = await open(noCoding, { runsAs: { dev: false, deployed: true } });
      const tools = await offered(agent);
      for (const name of ["write", "edit", "bash"]) expect(tools).not.toContain(name);
      expect(tools).toContain("weather");
      expect(tools).toContain("read");

      await expect(agent.sessions.create({ tools: ["bash"] })).rejects.toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining("bash"),
      });

      const prompts: string[] = [];
      faux.setResponses([
        (context: TranscriptContext) => {
          prompts.push(getCurrentSystemPrompt(context.messages));
          return fauxAssistantMessage("ok");
        },
      ]);
      await ask(agent, "hi");
      const prompt = prompts[0]!;
      expect(prompt).toContain("You are Support.");
      expect(prompt).not.toContain("Your working directory");
      expect(prompt).not.toContain(dir);
      expect(prompt).not.toContain("apt-get");
      expect(prompt).not.toContain("<available_skills>");

      // /skill:<name> command still expands the skill directly without needing the read tool.
      const info = await agent.info();
      expect(info.commands.map((command) => command.name)).toContain("skill:lookup-order");

      const emptyArray = {
        ...FILES,
        "fastagent.config.ts": `import { faux } from "./model.ts";
export default { model: "fixture/m", thinkingLevel: "low", codingTools: [], providers: [faux.provider] };
`,
      };
      const emptyTools = await offered((await open(emptyArray)).agent);
      for (const name of ["read", "write", "edit", "bash"]) expect(emptyTools).not.toContain(name);
    });

    it("codingTools subsets tailor installed tools and prompt guidance for read-only and no-bash agents", async () => {
      const readOnly = {
        ...FILES,
        "fastagent.config.ts": `import { faux } from "./model.ts";
export default { model: "fixture/m", thinkingLevel: "low", codingTools: ["read"], providers: [faux.provider] };
`,
      };
      const { agent: roAgent, faux: roFaux } = await open(readOnly, { runsAs: { dev: false, deployed: true } });
      const roTools = await offered(roAgent);
      expect(roTools).toContain("read");
      for (const name of ["write", "edit", "bash"]) expect(roTools).not.toContain(name);

      const roPrompts: string[] = [];
      roFaux.setResponses([
        (context: TranscriptContext) => {
          roPrompts.push(getCurrentSystemPrompt(context.messages));
          return fauxAssistantMessage("ok");
        },
      ]);
      await ask(roAgent, "hi");
      expect(roPrompts[0]).toContain("<available_skills>");
      expect(roPrompts[0]).toContain("Your working directory");
      expect(roPrompts[0]).not.toContain("files you create");
      expect(roPrompts[0]).not.toContain("apt-get");

      const noBash = {
        ...FILES,
        "fastagent.config.ts": `import { faux } from "./model.ts";
export default { model: "fixture/m", thinkingLevel: "low", codingTools: ["read", "write", "edit"], providers: [faux.provider] };
`,
      };
      const { agent: nbAgent, faux: nbFaux } = await open(noBash, { runsAs: { dev: false, deployed: true } });
      const nbTools = await offered(nbAgent);
      for (const name of ["read", "write", "edit"]) expect(nbTools).toContain(name);
      expect(nbTools).not.toContain("bash");

      const nbPrompts: string[] = [];
      nbFaux.setResponses([
        (context: TranscriptContext) => {
          nbPrompts.push(getCurrentSystemPrompt(context.messages));
          return fauxAssistantMessage("ok");
        },
      ]);
      await ask(nbAgent, "hi");
      expect(nbPrompts[0]).toContain("files you create");
      expect(nbPrompts[0]).toContain("Your directory survives restarts");
      expect(nbPrompts[0]).not.toContain("apt-get");
    });

    it("defineDefinition freezes an array codingTools setting so later caller mutation cannot alter it", () => {
      const selected: ("read" | "write" | "edit" | "bash")[] = ["read"];
      const def = defineDefinition({
        format: DEFINITION_FORMAT,
        builtWith: "0.0.0",
        name: "support",
        version: "0.0.0",
        dir: "/tmp/support",
        config: { codingTools: selected },
        registry: { tools: [] },
      });
      selected.push("bash");
      expect(def.config.codingTools).toEqual(["read"]);
      expect(Object.isFrozen(def.config.codingTools)).toBe(true);
    });

    it("refuses unknown, duplicate, or non-array codingTools values in fastagent.config.ts", async () => {
      const invalidName = agentPackage({
        ...FILES,
        "fastagent.config.ts": 'export default { codingTools: ["read", "rm"] };\n',
      });
      await expect(loadSourceDefinition(invalidName)).rejects.toThrow(/unknown coding tool "rm"/);

      const duplicate = agentPackage({
        ...FILES,
        "fastagent.config.ts": 'export default { codingTools: ["read", "read"] };\n',
      });
      await expect(loadSourceDefinition(duplicate)).rejects.toThrow(/duplicate coding tool "read"/);

      const wrongType = agentPackage({
        ...FILES,
        "fastagent.config.ts": 'export default { codingTools: "none" };\n',
      });
      await expect(loadSourceDefinition(wrongType)).rejects.toThrow(/"codingTools" must be a boolean or an array/);
    });
  });
});

describe("an agent whose configured default model the catalog does not have", () => {
  const RETIRED = "openai-codex/retired-model";
  const opened: LocalAgent[] = [];

  afterEach(async () => {
    for (const agent of opened.splice(0)) await agent.close();
  });

  async function agentWithDefault(model: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "fa-unusable-default-"));
    await writeFile(join(dir, "fastagent.config.ts"), `export default { model: "${model}" };\n`);
    return dir;
  }

  it("opens with no default, and says which model was configured and why it is unusable", async () => {
    const agent = await openSource(await agentWithDefault(RETIRED));
    opened.push(agent);
    const info = await agent.info();
    expect(info).not.toHaveProperty("defaultModel");
    expect(info.unusableDefault).toEqual({
      spec: RETIRED,
      reason: 'no provider "openai-codex" offers "retired-model"',
    });
  });

  it("refuses a message that names no model, as missing_model naming the default", async () => {
    const agent = await openSource(await agentWithDefault(RETIRED));
    opened.push(agent);
    const { id } = await agent.sessions.create();
    await expect(agent.messages.send({ sessionId: id, content: "hello" })).rejects.toMatchObject({
      code: "missing_model",
      message: expect.stringContaining(`the agent's default ${RETIRED} is unusable`),
    });
  });

  it("still refuses a model chosen when the agent is opened", async () => {
    const dir = await agentWithDefault(RETIRED);
    await expect(openSource(dir, { model: "openai-codex/typo" })).rejects.toThrow(
      'unknown model "openai-codex/typo": no provider "openai-codex" offers "typo"',
    );
  });
});

describe("startup warnings when a new version removes a tool or task with work in flight", () => {
  afterEach(() => vi.restoreAllMocks());

  it("warns naming the session and removed tool when resuming an in-flight tool call, settles cleanly, and stays quiet once idle", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-removed-tool-"));
    const dbPath = join(dir, "agent.sqlite");

    let entered!: () => void;
    const toolRunning = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const legacyTool = defineFastAgentTool({
      name: "legacy_tool",
      description: "Removed in v2.",
      parameters: { type: "object", properties: {} } as const,
      execute: async (_args, _api, ctx) => {
        entered();
        await new Promise<void>((resolve) => {
          ctx.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return { output: [{ type: "text", text: "never" }] };
      },
    });

    const v1Faux = fauxProvider({ provider: "gw", models: [{ id: "m1" }] });
    v1Faux.setResponses([fauxAssistantMessage([fauxToolCall("legacy_tool", {})], { stopReason: "toolUse" })]);
    const v1Registry = createRegistry();
    v1Registry.install({ name: "v1", tools: [legacyTool as ToolRegistration] });
    const models = (provider: ReturnType<typeof fauxProvider>["provider"]) =>
      modelsOver(new InMemoryCredentialStore(), [provider]);
    const v1 = await openDurableAgent({
      storage: await openLockedStorage(dbPath),
      models: models(v1Faux.provider),
      registry: v1Registry,
      name: "support",
      model: { provider: "gw", modelId: "m1" },
    });
    const session = await v1.sessions.create();
    const sent = await v1.messages.send({ sessionId: session.id, content: "run legacy" });
    await toolRunning;
    // Simulate deploy restart while `legacy_tool` is mid-flight.
    await v1.close();

    const warned: string[] = [];
    vi.spyOn(log, "warn").mockImplementation((line) => warned.push(line));

    const v2Faux = fauxProvider({ provider: "gw", models: [{ id: "m1" }] });
    v2Faux.setResponses([fauxAssistantMessage("handled missing tool")]);
    const v2 = await openDurableAgent({
      storage: await openLockedStorage(dbPath),
      models: models(v2Faux.provider),
      registry: createRegistry(),
      name: "support",
      model: { provider: "gw", modelId: "m1" },
    });
    try {
      expect(
        warned.some(
          (line) =>
            line.includes(`session ${session.id}`) &&
            line.includes("resuming in-flight work after tool(s) were removed: legacy_tool"),
        ),
        warned.join("\n"),
      ).toBe(true);
      const settled = await v2.messages.get({ sessionId: session.id, messageId: sent.id }, { wait: 15 });
      expect(settled.status).toBe("completed");
      expect(settled.answer?.text).toBe("handled missing tool");
    } finally {
      await v2.close();
    }

    // Once idle, reopening without `legacy_tool` emits no warning.
    warned.length = 0;
    const v3 = await openDurableAgent({
      storage: await openLockedStorage(dbPath),
      models: models(v2Faux.provider),
      registry: createRegistry(),
      name: "support",
      model: { provider: "gw", modelId: "m1" },
    });
    try {
      expect(warned).toEqual([]);
    } finally {
      await v3.close();
    }
  });

  it("warns naming the session and task kind when a live task is blocked by missing_task on restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-removed-task-"));
    const dbPath = join(dir, "agent.sqlite");

    const customTask = defineTask({
      name: "custom.sleeper",
      version: 1,
      initial: () => ({ phase: "wait" as const }),
      phases: {
        wait: async (_task, runtime, ctx) => {
          await runtime.commit(
            () => ({ status: "sleeping", until: Date.now() + 60 * 60_000, checkpoint: { phase: "wait" as const } }),
            ctx,
          );
        },
      },
      abort: async () => undefined,
    });
    const v1Faux = fauxProvider({ provider: "gw", models: [{ id: "m1" }] });
    const v1Registry = createRegistry();
    v1Registry.install({ name: "v1", tasks: [customTask] });
    const v1 = await openDurableAgent({
      storage: await openLockedStorage(dbPath),
      models: modelsOver(new InMemoryCredentialStore(), [v1Faux.provider]),
      registry: v1Registry,
      name: "support",
      model: { provider: "gw", modelId: "m1" },
    });
    const session = await v1.sessions.create();
    const conv = await v1.conversation(session.id);
    await conv?.commit(
      (tx) => tx.createTask(customTask, null, { ownership: { kind: "conversation" } }),
      BACKGROUND_CONTEXT,
    );
    await v1.close();

    const warned: string[] = [];
    vi.spyOn(log, "warn").mockImplementation((line) => warned.push(line));
    const v2 = await openDurableAgent({
      storage: await openLockedStorage(dbPath),
      models: modelsOver(new InMemoryCredentialStore(), [v1Faux.provider]),
      registry: createRegistry(),
      name: "support",
      model: { provider: "gw", modelId: "m1" },
    });
    try {
      expect(
        warned.some(
          (line) =>
            line.includes(`session ${session.id}`) &&
            line.includes("in-flight task custom.sleeper") &&
            line.includes("blocked (missing_task)"),
        ),
        warned.join("\n"),
      ).toBe(true);
    } finally {
      await v2.close();
    }
  });
});

describe("defineTool: Standard JSON Schema v1 (Zod / Effect Schema), plain JSON Schema, and structural TypeBox schemas", () => {
  it("adapts Standard JSON Schema v1 (Effect Schema and custom validate/transform), plain JSON Schema, and structural static schemas in real tool turns", async () => {
    const effectTool = defineFastAgentTool({
      name: "lookup_effect",
      description: "Lookup via Effect Standard JSON Schema v1",
      parameters: EffectSchema.toStandardJSONSchemaV1(
        EffectSchema.Struct({
          city: EffectSchema.String,
          count: EffectSchema.optional(EffectSchema.Finite),
        }),
      ),
      execute: async ({ city, count }) => `${city}:${count ?? 1}`,
    });
    expect(effectTool.parameters).not.toHaveProperty("$schema");
    expect(effectTool.parameters).toMatchObject({ type: "object", required: ["city"] });

    // Structural Standard JSON Schema v1 matching Zod v4 (defaults, transforms, refinements, draft-07 fallback).
    const zodLikeSchema = {
      "~standard": {
        version: 1 as const,
        vendor: "zod",
        jsonSchema: {
          input: ({ target }: { target: string }) => {
            if (target === "draft-2020-12") throw new Error("unsupported target");
            return {
              $schema: "http://json-schema.org/draft-07/schema#",
              type: "object",
              properties: {
                city: { type: "string" },
                units: { type: "string", enum: ["c", "f"] },
              },
              required: ["city"],
            };
          },
        },
        validate: (value: unknown) => {
          const input = value as { city?: string; units?: "c" | "f" };
          if (!input.city || input.city.trim() === "") {
            return { issues: [{ message: "city must not be blank", path: [{ key: "city" }] }] };
          }
          return { value: { city: input.city.trim().toUpperCase(), units: input.units ?? ("c" as const) } };
        },
        types: undefined as unknown as {
          input: { city: string; units?: "c" | "f" };
          output: { city: string; units: "c" | "f" };
        },
      },
    };
    const zodLikeTool = defineFastAgentTool({
      name: "weather_std",
      description: "Weather with Standard Schema default/transform/refine",
      parameters: zodLikeSchema,
      execute: async ({ city, units }) => `${city}/${units}`,
    });
    expect(zodLikeTool.parameters).not.toHaveProperty("$schema");

    const jsonSchemaTool = defineFastAgentTool({
      name: "search_json",
      description: "Search with plain JSON Schema",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "integer" },
        },
        required: ["query"],
      } as const,
      execute: async ({ query, limit }) => ({
        output: [{ type: "text", text: `q=${query} limit=${limit ?? 10}` }],
      }),
    });

    const structuralStaticSchema = {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      static: undefined as unknown as { text: string },
    };
    const piSchemaTool = defineFastAgentTool({
      name: "echo_pi",
      description: "Echo with structural static schema",
      parameters: structuralStaticSchema,
      execute: async ({ text }) => `echo:${text}`,
    });

    const faux = fauxProvider({ provider: "gw", models: [{ id: "m1" }] });
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("lookup_effect", { city: "Tokyo" }),
          fauxToolCall("weather_std", { city: "  paris " }),
          fauxToolCall("weather_std", { city: "   " }),
          fauxToolCall("search_json", { query: "agents", limit: 5 }),
          fauxToolCall("echo_pi", { text: "ok" }),
        ],
        { stopReason: "toolUse" },
      ),
      (context: TranscriptContext) => {
        const results = context.messages
          .filter((m) => m.role === "toolResult")
          .map(
            (m) =>
              `${m.toolName}:${m.isError ? "err:" : ""}${m.content.map((c) => ("text" in c ? c.text : "")).join("")}`,
          );
        return fauxAssistantMessage(results.join(" | "));
      },
    ]);
    const registry = createRegistry();
    registry.install({
      name: "custom",
      tools: [effectTool, zodLikeTool, jsonSchemaTool, piSchemaTool],
    });
    const agent = await openDurableAgent({
      storage: new MemoryStorage(),
      models: modelsOver(new InMemoryCredentialStore(), [faux.provider]),
      registry,
      name: "tools-test",
      model: { provider: "gw", modelId: "m1" },
    });
    try {
      const session = await agent.sessions.create();
      const msg = await agent.messages.send({ sessionId: session.id, content: "run all" }, { wait: 15 });
      expect(msg.status).toBe("completed");
      expect(msg.answer?.text).toContain("lookup_effect:Tokyo:1");
      expect(msg.answer?.text).toContain("weather_std:PARIS/c");
      expect(msg.answer?.text).toContain("weather_std:err:Invalid arguments: city: city must not be blank");
      expect(msg.answer?.text).toContain("search_json:q=agents limit=5");
      expect(msg.answer?.text).toContain("echo_pi:echo:ok");
    } finally {
      await agent.close();
    }
  });

  it("accepts raw Standard JSON Schema v1 tool objects in src/tools/ and fails fast on non-object or non-JSON-Schema Standard Schemas", async () => {
    expect(() =>
      defineFastAgentTool({
        name: "bad_non_obj",
        description: "Non-object schema",
        parameters: EffectSchema.toStandardJSONSchemaV1(EffectSchema.String),
        execute: async () => "no",
      }),
    ).toThrow(/type: "object"/);

    expect(() =>
      defineFastAgentTool({
        name: "bad_no_json_schema",
        description: "Standard Schema without jsonSchema",
        parameters: {
          "~standard": { version: 1, vendor: "legacy", validate: (v: unknown) => ({ value: v }) },
        } as unknown as Record<string, unknown>,
        execute: async () => "no",
      }),
    ).toThrow(/Standard Schema without JSON Schema support/);

    expect(() =>
      defineFastAgentTool({
        name: "bad_raw_type",
        description: "Plain non-object JSON schema",
        parameters: { type: "string" },
        execute: async () => "no",
      }),
    ).toThrow(/type: "object"/);

    // Raw Standard JSON Schema v1 tool objects exported without defineTool() compile and validate cleanly.
    const validRawStdDir = agentPackage({
      ...FILES,
      "src/tools/raw_effect.ts": `import * as Schema from "effect/Schema";
export default {
  name: "raw_effect",
  description: "Exported directly with Standard JSON Schema v1",
  parameters: Schema.toStandardJSONSchemaV1(Schema.Struct({ tag: Schema.String })),
  execute: async ({ tag }: { tag: string }) => "tag:" + tag,
};
`,
    });
    const validDef = await loadSourceDefinition(validRawStdDir);
    const validBuilt = buildDefinition(validDef, ENV);
    const rawCompiled = validBuilt.tools.find((t) => t.name === "raw_effect");
    expect(rawCompiled?.parameters).toMatchObject({ type: "object", required: ["tag"] });
    expect(await rawCompiled?.execute({ tag: "v1" }, { output: () => {}, executeTool: async () => ({}) }, {})).toEqual({
      output: [{ type: "text", text: "tag:v1" }],
    });

    // A Standard Schema missing JSON Schema v1 conversion still fails fast naming the tool file.
    const brokenStdDir = agentPackage({
      ...FILES,
      "src/tools/raw_std.ts": `export default {
  name: "raw_std",
  description: "Standard Schema without jsonSchema",
  parameters: { "~standard": { version: 1, vendor: "legacy" } },
  execute: async () => ({ output: [] }),
};
`,
    });
    const def = await loadSourceDefinition(brokenStdDir);
    expect(() => buildDefinition(def, ENV)).toThrow(
      /src\/tools\/raw_std\.ts:.*Standard Schema without JSON Schema support/,
    );
  });

  it("executes defineTool + sessionIdOf directly in unit tests without booting any harness", async () => {
    const stubApi: ToolExecutionApi = {
      output: () => {},
      executeTool: async () => ({}),
    };
    const whoami = defineFastAgentTool({
      name: "whoami",
      description: "Echo caller session",
      parameters: { type: "object", properties: { label: { type: "string" } }, required: ["label"] } as const,
      execute: async ({ label }, api, context) => {
        const sid = await sessionIdOf(api, context);
        return `${label}:${sid ?? "none"}`;
      },
    });
    expect(await whoami.execute({ label: "unit" }, stubApi, { sessionId: "sess-42" })).toEqual({
      output: [{ type: "text", text: "unit:sess-42" }],
    });
    expect(await whoami.execute({ label: "sub" }, stubApi, {})).toEqual({
      output: [{ type: "text", text: "sub:none" }],
    });
    await expect(sessionIdOf({ commit: async () => {}, conversationId: 1 }, {})).rejects.toThrow(
      "pi-durable tool api is missing FastAgent session binding",
    );
  });

  it("binds sessionIdOf and preserves live api getters on direct openDurableAgent registries and wrapTool wrappers", async () => {
    const inspectTool = defineFastAgentTool({
      name: "inspect_direct",
      description: "Read sessionIdOf and live api.models on direct openDurableAgent",
      parameters: { type: "object", properties: {} } as const,
      execute: async (_args, api, context) => {
        const desc = Object.getOwnPropertyDescriptor(api, "models");
        const sid = await sessionIdOf(api, context);
        return {
          output: [{ type: "text", text: `${sid}:${typeof desc?.get === "function" ? "live-getter" : "snapshot"}` }],
        };
      },
    }) as ToolRegistration;
    let wrapperSid: string | undefined;
    const faux = fauxProvider({ provider: "gw", models: [{ id: "m1" }] });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("inspect_direct", {})], { stopReason: "toolUse" }),
      (context) => fauxAssistantMessage(lastToolResult(context)),
    ]);
    const registry = createRegistry();
    registry.install({ name: "direct", tools: [inspectTool] });
    registry.install({
      name: "wrapper",
      wraps: [
        wrapTool(inspectTool, (base) => ({
          ...base,
          execute: async (args, api, context) => {
            wrapperSid = await sessionIdOf(api, context);
            return base.execute(args, api, context);
          },
        })),
      ],
    });
    const agent = await openDurableAgent({
      storage: new MemoryStorage(),
      models: modelsOver(new InMemoryCredentialStore(), [faux.provider]),
      registry,
      name: "direct-test",
      model: { provider: "gw", modelId: "m1" },
    });
    try {
      const session = await agent.sessions.create();
      const msg = await agent.messages.send({ sessionId: session.id, content: "check" }, { wait: 15 });
      expect(msg.answer?.text).toBe(`${session.id}:live-getter`);
      expect(wrapperSid).toBe(session.id);
    } finally {
      await agent.close();
    }
  });
});

describe("repository examples load and execute their tools end-to-end", () => {
  const repoRoot = new URL("../../../", import.meta.url).pathname;

  it("loads every example agent directory with expected tools, codingTools, and secrets", async () => {
    const specs = [
      { dir: "examples/pr-review-agent", secrets: {}, tools: ["fetch_github_pr"] },
      { dir: "examples/incident-triage-agent", secrets: {}, tools: ["probe_endpoint", "recent_commits"] },
      { dir: "examples/saas-copilot/agent", secrets: { TENANT_ID: "acme" }, tools: ["get_workspace_metrics"] },
      { dir: "examples/deep-research-agent", secrets: {}, tools: ["github_releases", "search_hacker_news"] },
    ];
    for (const spec of specs) {
      const def = await loadSourceDefinition(join(repoRoot, spec.dir));
      const built = buildDefinition(def, spec.secrets);
      expect(built.tools.map((t) => t.name).sort(), spec.dir).toEqual(spec.tools);
    }
  });

  it("executes saas-copilot and incident-triage SSRF guard through assembled agents", async () => {
    const runTool = async (
      relDir: string,
      secrets: Record<string, string>,
      toolName: string,
      toolArgs: Record<string, string | number | string[]>,
    ) => {
      const def = await loadSourceDefinition(join(repoRoot, relDir));
      const code = buildDefinition(def, secrets);
      const faux = fauxProvider({ provider: "gw", models: [{ id: "m1" }] });
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall(toolName, toolArgs)], { stopReason: "toolUse" }),
        (context) => fauxAssistantMessage(lastToolResult(context)),
      ]);
      const agent = await assembleAgent(def, {
        storage: new MemoryStorage(),
        runsAs: NOT_HOSTED,
        code,
        models: modelsOver(new InMemoryCredentialStore(), [faux.provider]),
        model: "gw/m1",
        processEnv: {},
      });
      try {
        const session = await agent.sessions.create();
        const msg = await agent.messages.send({ sessionId: session.id, content: "run" }, { wait: 10 });
        expect(msg.status).toBe("completed");
        return { sessionId: session.id, text: msg.answer?.text ?? "" };
      } finally {
        await agent.close();
      }
    };

    const saas = await runTool("examples/saas-copilot/agent", { TENANT_ID: "acme" }, "get_workspace_metrics", {
      windowDays: 14,
    });
    expect(JSON.parse(saas.text)).toMatchObject({ tenantId: "acme", sessionId: saas.sessionId, windowDays: 14 });

    const blocked = await runTool("examples/incident-triage-agent", {}, "probe_endpoint", {
      url: "https://127.0.0.1/admin",
    });
    expect(JSON.parse(blocked.text)).toMatchObject({ ok: false, error: expect.stringContaining("not permitted") });
  });
});
