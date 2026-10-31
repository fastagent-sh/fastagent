/**
 * A definition assembled onto pi-durable: the generated registry, the secrets manifest, the text read per request
 * (SYSTEM.md, AGENTS.md, skills loaded as pi loads them, prompt templates), and the code built with its secrets.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { modelsOver } from "../src/harnesses/models/models.ts";
import {
  InMemoryCredentialStore,
  type TranscriptContext,
  fauxAssistantMessage,
  type fauxProvider,
  fauxToolCall,
  getCurrentSystemPrompt,
} from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { DurableAgent } from "../src/harnesses/pi-durable/agent.ts";
import {
  type AssembleAgentOptions,
  buildDefinition,
  loadDefinition,
  assembleAgent,
  prepareDefinition,
  secretsManifest,
} from "../src/harnesses/pi-durable/open.ts";
import { openAgent, openServing } from "../src/harnesses/pi-durable/serve.ts";
import { listWakeups } from "../src/schedule/wakeups.ts";
import { DEV_SERVE_ENV } from "../src/serving-command.ts";
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
    expect(built.schedules.map((schedule) => schedule.name)).toEqual(["daily"]);
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

  it("refuses two extensions, channels, schedules or tools under one name, naming both", async () => {
    const extension = (name: string) =>
      `import { defineExtension } from "@earendil-works/pi-durable";\nexport default defineExtension({ name: "${name}" });\n`;
    const schedule = `import { defineSchedule } from "${DEFINE}";\nexport default defineSchedule({ cron: "0 9 * * *", prompt: "x" });\n`;
    const tool = `import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
export default defineTool({ name: "look", description: "d", parameters: Type.Object({}), execute: async () => ({ output: [] }) });
`;
    const channel = "export default () => ({});\n";
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
      [
        { "src/channels/hook.ts": channel, "src/channels/hook.mjs": channel },
        'src/channels/hook.mjs and src/channels/hook.ts both define the channel "hook"',
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
    const configured = (config: string) =>
      prepareDefinition(agentPackage({ "fastagent.config.ts": `export default ${config};\n` }));
    await expect(configured("{ modle: 'a/b' }")).rejects.toThrow('unknown key "modle"');
    // Below the top level too: a nested typo is as silent as a top-level one.
    await expect(configured("{ http: { prot: 80 } }")).rejects.toThrow('"http": unknown key "prot" (keys: port, api)');
    await expect(configured("{ http: { port: 70000 } }")).rejects.toThrow('"http.port" must be an integer 0-65535');
    await expect(configured("{ deploy: { agentcore: { idleTimeoutSeconds: 30 } } }")).rejects.toThrow(
      '"deploy.agentcore.idleTimeoutSeconds" must be an integer 60-1209600',
    );
    await expect(configured("{ deploy: { fly: {} } }")).rejects.toThrow('"deploy": unknown key "fly"');
    await expect(configured("{ http: { api: 'no' } }")).rejects.toThrow('"http.api" must be true or false');
    await expect(loadDefinition(agentPackage({}))).rejects.toThrow(".fastagent/registry.ts is missing");
  });

  describe("opened", () => {
    const opened: DurableAgent[] = [];
    afterAll(async () => {
      for (const agent of opened) await agent.close();
    });

    async function open(files = FILES, options: Partial<AssembleAgentOptions> = {}, opening = (dir: string) => dir) {
      const dir = agentPackage(files);
      const definition = await prepareDefinition(opening(dir));
      const { faux } = (await import(join(dir, "model.ts"))) as { faux: ReturnType<typeof fauxProvider> };
      const code = buildDefinition(definition, ENV);
      const agent = await assembleAgent(definition, {
        storage: new MemoryStorage(),
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

    it("reads a skill where its prompt says it is, when the agent was opened by a relative path", async () => {
      // An embedder's `openServing("./agent")`: a relative location in the prompt would resolve against the agent's
      // own working directory, the agent directory itself, and name a file that is not there.
      const { agent, faux } = await open(FILES, {}, (dir) => relative(process.cwd(), dir));
      faux.setResponses([
        (context) => {
          const location = /<location>(.*)<\/location>/.exec(getCurrentSystemPrompt(context.messages))?.[1];
          if (location === undefined) throw new Error("the prompt names no skill location");
          return toolCall("read", { path: location });
        },
        (context) => fauxAssistantMessage(`saw: ${lastToolResult(context)}`),
      ]);
      const end = await ask(agent, "where is order 7?");
      expect(end.answer?.text).toContain("Ask for the order number, then read references/codes.md.");
    });

    it("what it runs from a dev process is not dev: the bash tool's children do not inherit the mark", async () => {
      const { agent, faux } = await open();
      process.env[DEV_SERVE_ENV] = "1";
      try {
        faux.setResponses([
          () => toolCall("bash", { command: `printf "[%s]" "$${DEV_SERVE_ENV}"` }),
          (context) => fauxAssistantMessage(lastToolResult(context)),
        ]);
        expect((await ask(agent, "run it")).answer?.text).toContain("[]");
        expect(process.env[DEV_SERVE_ENV]).toBe("1"); // the serving process itself keeps it
      } finally {
        delete process.env[DEV_SERVE_ENV];
      }
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
      const sessionId = (await agent.sessions.create()).id;
      await agent.messages.send({ sessionId, content: "remind me" }, { wait: 30 });
      const [wakeup] = listWakeups(stateRoot);
      if (wakeup === undefined) throw new Error("wake kept no wake-up");
      expect(wakeup).toMatchObject({ session: sessionId, prompt: "check the deploy" });
      faux.setResponses([
        () => toolCall("unwake", { id: wakeup.id }),
        (context) => fauxAssistantMessage(lastToolResult(context)),
      ]);
      expect(await agent.messages.send({ sessionId, content: "never mind" }, { wait: 30 })).toMatchObject({
        answer: { text: `OK — wake-up ${wakeup.id} cancelled.` },
      });
      expect(listWakeups(stateRoot)).toEqual([]);
    });
  });
});

describe("two agents in one process", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("each runs on its own value file: its code, its commands and its model keys, the process's left alone", async () => {
    for (const name of ["WEATHER_KEY", "GH_TOKEN", "ANTHROPIC_API_KEY"]) vi.stubEnv(name, undefined);
    const before = { ...process.env };
    const agents = [
      {
        values: "WEATHER_KEY=k-a\nGH_TOKEN=gh-a\nANTHROPIC_API_KEY=sk-a\n",
        key: "k-a",
        token: "gh-a",
        anthropic: true,
      },
      { values: "WEATHER_KEY=k-b\nGH_TOKEN=gh-b\n", key: "k-b", token: "gh-b", anthropic: false },
    ].map((agent) => ({ ...agent, dir: agentPackage({ ...FILES, ".secrets/.env": agent.values }) }));
    const opened = [];
    for (const { dir } of agents) {
      opened.push(await openServing(dir, { storage: "memory", credentialStore: new InMemoryCredentialStore() }));
    }
    try {
      for (const [i, { dir, key, token, anthropic }] of agents.entries()) {
        const { agent, models } = opened[i] as (typeof opened)[number];
        const { faux } = (await import(join(dir, "model.ts"))) as { faux: ReturnType<typeof fauxProvider> };
        const answer = async (call: ReturnType<typeof toolCall>) => {
          faux.setResponses([() => call, (context) => fauxAssistantMessage(lastToolResult(context))]);
          const sessionId = (await agent.sessions.create()).id;
          return (await agent.messages.send({ sessionId, content: "go" }, { wait: 30 })).answer?.text;
        };
        expect(await answer(toolCall("weather", { city: "London" }))).toBe(`London: sunny (key ${key}, region none)`);
        expect(await answer(toolCall("bash", { command: 'printf "[%s]" "$GH_TOKEN"' }))).toContain(`[${token}]`);
        expect((await models.authStatus("anthropic")).source).toBe(anthropic ? "ANTHROPIC_API_KEY" : undefined);
        // A request reads it too, as Bedrock reads its region and Azure its endpoint, not only the auth before it.
        faux.setResponses([(_context, options) => fauxAssistantMessage(`request env: ${options?.env?.GH_TOKEN}`)]);
        const sessionId = (await agent.sessions.create()).id;
        expect((await agent.messages.send({ sessionId, content: "go" }, { wait: 30 })).answer?.text).toBe(
          `request env: ${token}`,
        );
      }
      expect(process.env).toEqual(before);
    } finally {
      for (const { agent } of opened) await agent.close();
    }
  });
});

describe("an agent's value file names where its state and credentials are", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("as dev reads it: FASTAGENT_STATE_DIR and FASTAGENT_AUTH_PATH from .secrets/.env, the process's left alone", async () => {
    for (const name of ["FASTAGENT_STATE_DIR", "FASTAGENT_AUTH_PATH"]) vi.stubEnv(name, undefined);
    const elsewhere = mkdtempSync(join(tmpdir(), "fa-value-file-paths-"));
    const dir = agentPackage({
      ...FILES,
      ".secrets/.env": `WEATHER_KEY=k\nGH_TOKEN=g\nFASTAGENT_STATE_DIR=${join(elsewhere, "state")}\nFASTAGENT_AUTH_PATH=${join(elsewhere, "auth.json")}\n`,
    });
    const opened = await openServing(dir);
    try {
      expect(opened.stateRoot).toBe(join(elsewhere, "state"));
      expect(opened.models.auth).toEqual({ path: join(elsewhere, "auth.json") });
      expect(process.env.FASTAGENT_STATE_DIR).toBeUndefined();
    } finally {
      await opened.agent.close();
    }
  });
});

describe("an app's openAgent", () => {
  it("refuses a wake-up while the app does not serve the agent, since only a serve's clock fires one", async () => {
    const dir = agentPackage(FILES);
    for (const [name, value] of Object.entries(ENV)) process.env[name] = value;
    const agent = await openAgent(dir, { stateDir: join(dir, ".host-state") });
    try {
      const { faux } = (await import(join(dir, "model.ts"))) as { faux: ReturnType<typeof fauxProvider> };
      const wake = async () => {
        faux.setResponses([
          () => toolCall("wake", { in: "1h", prompt: "check the deploy" }),
          (context) => fauxAssistantMessage(lastToolResult(context)),
        ]);
        const sessionId = (await agent.sessions.create()).id;
        return (await agent.messages.send({ sessionId, content: "remind me" }, { wait: 30 })).answer?.text;
      };
      expect(await wake()).toContain("nothing fires wake-ups for this agent now");
      expect(listWakeups(join(dir, ".host-state"))).toEqual([]);
      const service = await agent.serve();
      expect(await wake()).toContain("OK — I'll wake up at");
      expect(listWakeups(join(dir, ".host-state"))).toHaveLength(1);
      // The service closed alone, the agent still open: its clock is gone with it.
      await service.close();
      expect(await wake()).toContain("nothing fires wake-ups for this agent now");
      expect(listWakeups(join(dir, ".host-state"))).toHaveLength(1);
    } finally {
      await agent.close();
      for (const name of Object.keys(ENV)) delete process.env[name];
    }
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
