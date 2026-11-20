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
import { MemoryStorage, createRegistry, defineTask, defineTool } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { type DurableAgent, openDurableAgent } from "../../../packages/fastagent/src/harnesses/pi-durable/agent.ts";
import {
  type AssembleAgentOptions,
  buildDefinition,
  assembleAgent,
  loadSourceDefinition,
} from "../../../packages/fastagent/src/harnesses/pi-durable/open.ts";
import type { LocalAgent } from "../../../packages/fastagent/src/harnesses/pi-durable/serve.ts";
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
    expect(registry.schedules).toEqual([{ file: "src/schedules/daily.ts", name: "daily", value: expect.any(Object) }]);
    expect(readdirSync(dir, { recursive: true }).sort()).toEqual(before);
  });

  it("refuses to run while a required secret has no value, naming where it is declared, and not for an optional one", async () => {
    const definition = await loadSourceDefinition(agentPackage(FILES));
    expect(() => buildDefinition(definition, { GH_TOKEN: "gh" })).toThrow(
      "missing required secrets: WEATHER_KEY (src/tools/weather.ts)",
    );
    const built = buildDefinition(definition, ENV);
    expect(built.tools.map((tool) => tool.name)).toEqual(["weather"]);
    expect(built.extensions.map((extension) => extension.name)).toEqual(["audit"]);
    expect(built.schedules.map((schedule) => schedule.name)).toEqual(["daily"]);
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

    it("renders SYSTEM.md, AGENTS.md, the skills it may load and its extensions' sections, read for each request", async () => {
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
      expect(first).toContain("Every answer is audited.");
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

    it("offers wake and unwake when a serve gives it a clock, and neither when the definition defines one", async () => {
      expect(await offered((await open()).agent)).not.toContain("wake");
      expect(await offered((await open(FILES, { clocked: true })).agent)).toEqual(
        expect.arrayContaining(["wake", "unwake"]),
      );
      const ownWake = {
        ...FILES,
        "src/tools/wake.ts": `import { obj, str } from "@earendil-works/pi-schema";
import { defineTool } from "@earendil-works/pi-durable";
export default defineTool({
  name: "wake",
  description: "The author's own",
  parameters: obj({}),
  execute: async () => ({ output: [{ type: "text", text: "own" }] }),
});
`,
      };
      const tools = await offered((await open(ownWake, { clocked: true })).agent);
      expect(tools).toContain("wake");
      expect(tools).not.toContain("unwake");
    });

    it("codingTools: false disables read/write/edit/bash and omits workspace and read-based skills from the system prompt", async () => {
      const noCoding = {
        ...FILES,
        "fastagent.config.ts": `import { faux } from "./model.ts";
export default { model: "fixture/m", thinkingLevel: "low", codingTools: false, providers: [faux.provider] };
`,
      };
      const { dir, agent, faux } = await open(noCoding, { runsAs: { dev: false, deployed: true } });
      const tools = await offered(agent);
      for (const name of ["read", "write", "edit", "bash"]) expect(tools).not.toContain(name);
      expect(tools).toContain("weather");

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
    });

    it("codingTools: ['read'] installs only the requested subset and keeps skills in the prompt", async () => {
      const readOnly = {
        ...FILES,
        "fastagent.config.ts": `import { faux } from "./model.ts";
export default { model: "fixture/m", thinkingLevel: "low", codingTools: ["read"], providers: [faux.provider] };
`,
      };
      const { agent, faux } = await open(readOnly);
      const tools = await offered(agent);
      expect(tools).toContain("read");
      for (const name of ["write", "edit", "bash"]) expect(tools).not.toContain(name);

      const prompts: string[] = [];
      faux.setResponses([
        (context: TranscriptContext) => {
          prompts.push(getCurrentSystemPrompt(context.messages));
          return fauxAssistantMessage("ok");
        },
      ]);
      await ask(agent, "hi");
      expect(prompts[0]).toContain("<available_skills>");
      expect(prompts[0]).toContain("Your working directory");
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
    const legacyTool = defineTool({
      name: "legacy_tool",
      description: "Removed in v2.",
      parameters: obj({}),
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
    v1Registry.install({ name: "v1", tools: [legacyTool] });
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
