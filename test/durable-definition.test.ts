/**
 * A definition assembled onto pi-durable: the definition as a value, its declared secrets, the text read per request
 * (SYSTEM.md, AGENTS.md, skills loaded as pi loads them, prompt templates), and the code built with its secrets.
 */
import { resolveConfig } from "../src/harnesses/pi-durable/config.ts";
import { mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { modelsOver } from "../src/harnesses/models/models.ts";
import {
  InMemoryCredentialStore,
  type TranscriptContext,
  fauxAssistantMessage,
  type fauxProvider,
  getCurrentSystemPrompt,
} from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterAll, describe, expect, it } from "vitest";
import type { DurableAgent } from "../src/harnesses/pi-durable/agent.ts";
import {
  type AssembleAgentOptions,
  buildDefinition,
  assembleAgent,
  loadSourceDefinition,
} from "../src/harnesses/pi-durable/open.ts";
import { NOT_HOSTED } from "../src/serving-command.ts";
import { made, agentPackage, FILES, ENV, toolCall, lastToolResult } from "./durable-definition-fixtures.ts";

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
        config: resolveConfig(definition),
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

    it("offers wake and unwake when a serve gives its state, and neither when the definition defines one", async () => {
      const stateRoot = mkdtempSync(join(tmpdir(), "fastagent-wake-"));
      expect(await offered((await open()).agent)).not.toContain("wake");
      expect(await offered((await open(FILES, { stateRoot })).agent)).toEqual(
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
      const tools = await offered((await open(ownWake, { stateRoot })).agent);
      expect(tools).toContain("wake");
      expect(tools).not.toContain("unwake");
    });
  });
});
