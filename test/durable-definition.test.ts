/**
 * A definition assembled onto pi-durable: the generated registry, the secrets manifest, the text read per request
 * (SYSTEM.md, AGENTS.md, skills loaded as pi loads them, prompt templates), and the code built with its secrets.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  InMemoryCredentialStore,
  type TranscriptContext,
  fauxAssistantMessage,
  type fauxProvider,
  fauxToolCall,
  getCurrentSystemPrompt,
} from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterAll, describe, expect, it } from "vitest";
import type { DurableAgent } from "../src/harnesses/pi-durable/agent.ts";
import {
  type OpenAgentOptions,
  buildDefinition,
  loadDefinition,
  openAgent,
  prepareDefinition,
  secretsManifest,
} from "../src/harnesses/pi-durable/open.ts";
import { listWakeups } from "../src/schedule/wakeups.ts";
import { registrySource } from "../src/harnesses/pi-durable/registry.ts";
import { expandTemplate, parseArguments } from "../src/harnesses/pi-durable/text.ts";

// Under test/fixtures, so the agent's modules resolve this repository's packages and its src/ by a fixed depth.
const ROOT = join(import.meta.dirname, "fixtures");
const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const DEFINE = "../../../../../src/harnesses/pi-durable/define.ts";

/** An agent package with `files`, its directory under test/fixtures. */
function agentPackage(files: Record<string, string>): string {
  const dir = join(ROOT, `.tmp-${process.pid}-${made.length}`);
  made.push(dir);
  for (const [file, text] of Object.entries({ "package.json": '{ "name": "support", "type": "module" }', ...files })) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  return dir;
}

/** A model scripted through a module both the agent's configuration and the test import: one instance, by URL. */
const MODEL_MODULE = `import { fauxProvider } from "@earendil-works/pi-ai";
export const faux = fauxProvider({ provider: "fixture", models: [{ id: "m" }] });
`;

const FILES: Record<string, string> = {
  "model.ts": MODEL_MODULE,
  "fastagent.config.ts": `import { faux } from "./model.ts";
export default { model: "fixture/m", thinkingLevel: "low", providers: [faux.provider] };
`,
  "SYSTEM.md": "You are Support.\n",
  "AGENTS.md": "Be brief.\n",
  "skills/lookup-order/SKILL.md": `---
name: lookup-order
description: Look an order up. Use when a customer names an order.
---
Ask for the order number, then read references/codes.md.
`,
  "skills/Not_Valid/SKILL.md": "---\nname: Not_Valid\ndescription: broken\n---\nbody\n",
  "prompts/review.md": "---\ndescription: Review something\n---\nReview $1 carefully. Everything: $@\n",
  "src/tools/weather.ts": `import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { needs } from "${DEFINE}";
export default needs(
  [{ name: "WEATHER_KEY", description: "The weather service's API key" }, { name: "WEATHER_REGION", optional: true }],
  ({ WEATHER_KEY, WEATHER_REGION }) =>
    defineTool({
      name: "weather",
      description: "Tells the weather",
      parameters: Type.Object({ city: Type.String() }),
      execute: async (args) => ({
        output: [{ type: "text", text: \`\${args.city}: sunny (key \${WEATHER_KEY}, region \${WEATHER_REGION ?? "none"})\` }],
      }),
    }),
);
`,
  "src/tools/weather.test.ts": "throw new Error('a test file is not a module');\n",
  "src/extensions/audit.ts": `import { defineExtension, section } from "@earendil-works/pi-durable";
export default defineExtension({ name: "audit", sections: [section("audit", () => "Every answer is audited.")] });
`,
  "src/schedules/daily.ts": `import { defineSchedule } from "${DEFINE}";
export default defineSchedule({ cron: "0 9 * * *", tz: "Europe/London", prompt: ({ at }) => \`Report for \${at.toISOString()}\` });
`,
  "context.json": JSON.stringify({ environment: { variables: { GH_TOKEN: { description: "For gh" } } } }),
};

const ENV = { WEATHER_KEY: "k-123", GH_TOKEN: "gh" };

describe("an agent definition on pi-durable", () => {
  it("registers each module of src/ by its default export, tests left out, the same wherever it is generated", async () => {
    const dir = agentPackage(FILES);
    const source = await registrySource(dir);
    expect(source).toContain('import m0 from "../src/tools/weather.ts";');
    expect(source).not.toContain("weather.test");
    expect(source).toContain('{ file: "src/schedules/daily.ts", name: "daily", value: m2 }');
    expect(await registrySource(dir)).toBe(source);
  });

  it("writes one manifest of the secrets it declares: what each is for, whether it is optional, where it is declared", async () => {
    const dir = agentPackage(FILES);
    const definition = await prepareDefinition(dir);
    const manifest = JSON.parse(readFileSync(join(dir, ".fastagent/secrets.json"), "utf8"));
    expect(manifest).toEqual(secretsManifest(definition));
    expect(manifest).toEqual([
      { name: "GH_TOKEN", description: "For gh", optional: false, declaredIn: ["context.json"] },
      {
        name: "WEATHER_KEY",
        description: "The weather service's API key",
        optional: false,
        declaredIn: ["src/tools/weather.ts"],
      },
      { name: "WEATHER_REGION", optional: true, declaredIn: ["src/tools/weather.ts"] },
    ]);
  });

  it("refuses to run while a required secret has no value, naming where it is declared, and not for an optional one", async () => {
    const definition = await prepareDefinition(agentPackage(FILES));
    expect(() => buildDefinition(definition, { GH_TOKEN: "gh" })).toThrow(
      "missing required secrets: WEATHER_KEY (src/tools/weather.ts)",
    );
    const built = buildDefinition(definition, ENV);
    expect(built.tools.map((tool) => tool.name)).toEqual(["weather"]);
    expect(built.extensions.map((extension) => extension.name)).toEqual(["audit"]);
    expect([...built.schedules.keys()]).toEqual(["daily"]);
  });

  it("builds its channels, a route channel and a long connection, each with the secrets it declared", async () => {
    const definition = await prepareDefinition(
      agentPackage({
        "src/channels/hook.ts": `import { needs } from "${DEFINE}";
export default needs(["HOOK_SECRET"], ({ HOOK_SECRET }) => () => ({ "POST /hook": () => new Response(HOOK_SECRET) }));
`,
        "src/channels/stream.ts":
          "export default { name: 'stream', connect: () => ({ ready: Promise.resolve(), closed: new Promise(() => {}) }) };\n",
      }),
    );
    expect(secretsManifest(definition)).toEqual([
      { name: "HOOK_SECRET", optional: false, declaredIn: ["src/channels/hook.ts"] },
    ]);
    expect(() => buildDefinition(definition, {})).toThrow(
      "missing required secrets: HOOK_SECRET (src/channels/hook.ts)",
    );
    const { channels } = buildDefinition(definition, { HOOK_SECRET: "s-1" });
    expect([...channels.keys()]).toEqual(["hook", "stream"]);
    const hook = channels.get("hook");
    if (typeof hook !== "function") throw new Error("hook is not a route channel");
    const routes = hook({} as Parameters<typeof hook>[0]);
    expect(await (routes["POST /hook"] as () => Response)().text()).toBe("s-1");
    expect(channels.get("stream")).toMatchObject({ name: "stream" });
  });

  it("refuses two extensions, two schedules or two tools under one name, naming both", async () => {
    const extension = (name: string) =>
      `import { defineExtension } from "@earendil-works/pi-durable";\nexport default defineExtension({ name: "${name}" });\n`;
    const schedule = `import { defineSchedule } from "${DEFINE}";\nexport default defineSchedule({ cron: "0 9 * * *", prompt: "x" });\n`;
    const tool = `import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
export default defineTool({ name: "look", description: "d", parameters: Type.Object({}), execute: async () => ({ output: [] }) });
`;
    const cases: [Record<string, string>, string][] = [
      [
        { "src/tools/a.ts": tool, "src/tools/b.ts": tool },
        'src/tools/a.ts and src/tools/b.ts both define the tool "look"',
      ],
      [
        { "src/extensions/a.ts": extension("audit"), "src/extensions/b.ts": extension("audit") },
        'src/extensions/a.ts and src/extensions/b.ts both define the extension "audit"',
      ],
      [
        { "src/extensions/tools.ts": extension("coding-tools") },
        `pi-durable's coding tools and src/extensions/tools.ts both define the extension "coding-tools"`,
      ],
      [
        { "src/schedules/daily.ts": schedule, "src/schedules/daily.mts": schedule },
        'src/schedules/daily.mts and src/schedules/daily.ts both define the schedule "daily"',
      ],
    ];
    for (const [files, message] of cases) {
      const definition = await prepareDefinition(agentPackage(files));
      expect(() => buildDefinition(definition, {})).toThrow(message);
    }
  });

  it("refuses a module that is not what its directory holds, a bad cron and an unknown configuration key", async () => {
    const notATool = await prepareDefinition(agentPackage({ "src/tools/x.ts": "export default { name: 'x' };\n" }));
    expect(() => buildDefinition(notATool, {})).toThrow("src/tools/x.ts: must default-export a tool");
    const notAChannel = await prepareDefinition(
      agentPackage({ "src/channels/x.ts": "export default { name: 'x' };\n" }),
    );
    expect(() => buildDefinition(notAChannel, {})).toThrow("src/channels/x.ts: must default-export (ctx) => Routes");
    const unnamed = await prepareDefinition(
      agentPackage({ "src/channels/x.ts": "export default { name: ' ', connect() {} };\n" }),
    );
    expect(() => buildDefinition(unnamed, {})).toThrow("src/channels/x.ts: long-connection channel name");
    const badCron = await prepareDefinition(
      agentPackage({
        "src/schedules/often.ts": `import { defineSchedule } from "${DEFINE}";\nexport default defineSchedule({ cron: "not a cron", prompt: "x" });\n`,
      }),
    );
    expect(() => buildDefinition(badCron, {})).toThrow("src/schedules/often.ts:");
    await expect(
      prepareDefinition(agentPackage({ "fastagent.config.ts": "export default { modle: 'a/b' };\n" })),
    ).rejects.toThrow('unknown key "modle"');
    await expect(loadDefinition(agentPackage({}))).rejects.toThrow(".fastagent/registry.ts is missing");
  });

  describe("opened", () => {
    const opened: DurableAgent[] = [];
    afterAll(async () => {
      for (const agent of opened) await agent.close();
    });

    async function open(files = FILES, options: Partial<OpenAgentOptions> = {}) {
      const dir = agentPackage(files);
      const definition = await prepareDefinition(dir);
      const { faux } = (await import(join(dir, "model.ts"))) as { faux: ReturnType<typeof fauxProvider> };
      const agent = await openAgent(definition, {
        storage: new MemoryStorage(),
        credentials: new InMemoryCredentialStore(),
        env: ENV,
        ...options,
      });
      opened.push(agent);
      return { dir, agent, faux };
    }

    async function ask(agent: DurableAgent, text: string) {
      const receipt = await agent.invoke({ content: [{ type: "text", text }] });
      if (!receipt.ok) throw new Error(JSON.stringify(receipt));
      const end = await receipt.wait();
      if (!end.ok) throw new Error(end.unfinished.reason);
      return end.message;
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

    it("lets the model read a skill's SKILL.md through its execution environment", async () => {
      const { dir, agent, faux } = await open();
      const path = join(dir, "skills/lookup-order/SKILL.md");
      faux.setResponses([
        () => toolCall("read", { path }),
        (context) => fauxAssistantMessage(`saw: ${lastToolResult(context)}`),
      ]);
      const end = await ask(agent, "where is order 7?");
      expect(end.answer?.text).toContain("Ask for the order number, then read references/codes.md.");
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
      expect(agent.info()).toMatchObject({
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
      const created = await agent.createSession();
      if (!created.ok) throw new Error(JSON.stringify(created));
      const conversation = await agent.conversation(created.sessionId);
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
        "src/tools/wake.ts": `import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
export default defineTool({
  name: "wake",
  description: "The author's own",
  parameters: Type.Object({}),
  execute: async () => ({ output: [{ type: "text", text: "own" }] }),
});
`,
      };
      const tools = await offered((await open(ownWake, { stateRoot })).agent);
      expect(tools).toContain("wake");
      expect(tools).not.toContain("unwake");
    });

    it("keeps a wake-up for the session it was set in, and cancels it there with unwake", async () => {
      const stateRoot = mkdtempSync(join(tmpdir(), "fastagent-wake-"));
      const { agent, faux } = await open(FILES, { stateRoot });
      faux.setResponses([
        () => toolCall("wake", { in: "30m", prompt: "check the deploy" }),
        (context) => fauxAssistantMessage(lastToolResult(context)),
      ]);
      const receipt = await agent.invoke({ content: [{ type: "text", text: "remind me" }] });
      if (!receipt.ok) throw new Error(JSON.stringify(receipt));
      await receipt.wait();
      const [wakeup] = listWakeups(stateRoot);
      if (wakeup === undefined) throw new Error("wake kept no wake-up");
      expect(wakeup).toMatchObject({ session: receipt.sessionId, prompt: "check the deploy" });
      faux.setResponses([
        () => toolCall("unwake", { id: wakeup.id }),
        (context) => fauxAssistantMessage(lastToolResult(context)),
      ]);
      const again = await agent.invoke({
        sessionId: receipt.sessionId,
        content: [{ type: "text", text: "never mind" }],
      });
      if (!again.ok) throw new Error(JSON.stringify(again));
      expect(await again.wait()).toMatchObject({
        ok: true,
        message: { answer: { text: `OK — wake-up ${wakeup.id} cancelled.` } },
      });
      expect(listWakeups(stateRoot)).toEqual([]);
    });
  });
});

describe("prompt templates", () => {
  it("expand pi's argument forms", () => {
    const args = parseArguments(`one "two three" '' four`);
    expect(args).toEqual(["one", "two three", "", "four"]);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: pi's template syntax, not a JavaScript template
    expect(expandTemplate("$1|$2|$@|$ARGUMENTS|${3:-dflt}|${@:2}|${@:2:1}|$9", args)).toBe(
      "one|two three|one two three  four|one two three  four|dflt|two three  four|two three|",
    );
  });
});

const toolCall = (name: string, args: Record<string, string>) =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

function lastToolResult(context: TranscriptContext): string {
  const result = context.messages.at(-1);
  if (result?.role !== "toolResult") throw new Error("the model was not answering a tool call");
  return result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}
