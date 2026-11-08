/**
 * An instance's instructions, skills and prompt templates (agent-artifact.md §4.2, §7): what its configuration declares
 * is read for each message and nothing else is, and a declaration the program's own text or another entry's name
 * contradicts refuses the open.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { InMemoryCredentialStore, type TranscriptContext, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { modelsOver } from "../src/harnesses/models/models.ts";
import type { DurableAgent } from "../src/harnesses/pi-durable/agent.ts";
import { type InstanceConfigSource, resolveConfig } from "../src/harnesses/pi-durable/config.ts";
import { assembleAgent, buildDefinition, loadSourceDefinition } from "../src/harnesses/pi-durable/open.ts";
import { openText } from "../src/harnesses/pi-durable/text.ts";
import { openAgent } from "../src/harnesses/pi-durable/serve.ts";
import { log } from "../src/log.ts";
import { runInProcess } from "./cli-run.ts";
import { makeFaux, sentPrompt } from "./faux.ts";
import { NOT_HOSTED } from "../src/serving-command.ts";

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
afterEach(() => vi.restoreAllMocks());

function write(root: string, files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
}

const skill = (name: string, description = `Does ${name}.`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\nHow to ${name}.\n`;

/** A program (its directory) and an instance configuration beside it, each with `files`. */
function layout(program: Record<string, string>, instance: Record<string, string> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fa-text-")));
  made.push(root);
  const dir = join(root, "program");
  const config = join(root, "instance");
  mkdirSync(dir);
  mkdirSync(config);
  write(dir, { "package.json": '{ "name": "support" }', ...program });
  write(config, instance);
  return { root, dir, config };
}

/** The `fastagent.json` at `config` with `values`, read as the opener reads it. */
const source = (config: string, values: object): InstanceConfigSource => ({
  values,
  label: join(config, "fastagent.json"),
  directory: config,
});

async function openAgentOn(dir: string, instance: InstanceConfigSource | undefined) {
  const { faux, models: _ } = makeFaux();
  const definition = await loadSourceDefinition(dir);
  const agent: DurableAgent = await assembleAgent(definition, {
    storage: new MemoryStorage(),
    runsAs: NOT_HOSTED,
    processEnv: {},
    code: { ...buildDefinition(definition, {}), providers: [faux.provider] },
    config: resolveConfig(definition, instance),
    text: openText(definition.dir, instance),
    models: modelsOver(new InMemoryCredentialStore(), [faux.provider]),
    model: "faux/faux-1",
  });
  const prompts: string[] = [];
  const ask = async (text: string) => {
    faux.setResponses([
      (context: TranscriptContext) => {
        prompts.push(sentPrompt(context));
        return fauxAssistantMessage("ok");
      },
    ]);
    const sent = await agent.messages.send(
      { sessionId: (await agent.sessions.create()).id, content: text },
      { wait: 30 },
    );
    return sent;
  };
  return { agent, ask, prompts };
}

describe("an instance's text", () => {
  it("adds its instructions, skills and prompt templates to the program's, and reads each for every message", async () => {
    const { dir, config } = layout(
      { "AGENTS.md": "Be brief.\n", "skills/triage/SKILL.md": skill("triage"), "prompts/plan.md": "Plan $1.\n" },
      {
        "notes/house-rules.md": "Answer in English.\n",
        "extra-skills/audit/SKILL.md": skill("audit"),
        "extra-prompts/review.md": "---\ndescription: Review\n---\nReview $1.\n",
      },
    );
    const values = {
      instructions: ["./notes/house-rules.md"],
      skills: ["./extra-skills"],
      prompts: ["./extra-prompts"],
    };
    const { agent, ask, prompts } = await openAgentOn(dir, source(config, values));
    try {
      await ask("hi");
      const [first] = prompts as [string];
      expect(first).toContain("<project_context>\nBe brief.\n</project_context>");
      expect(first).toContain("<instance_context>\nAnswer in English.\n</instance_context>");
      expect(first.indexOf("Be brief.")).toBeLessThan(first.indexOf("Answer in English."));
      expect(first).toContain("<name>triage</name>");
      expect(first).toContain(`<location>${join(config, "extra-skills/audit/SKILL.md")}</location>`);
      expect((await agent.info()).commands.map((c) => c.name)).toEqual([
        "plan",
        "review",
        "skill:triage",
        "skill:audit",
      ]);

      // An edit inside a declared path takes effect on the next message, a new file in it too.
      writeFileSync(join(config, "notes/house-rules.md"), "Answer in French.\n");
      write(config, { "extra-skills/deploy/SKILL.md": skill("deploy") });
      await ask("again");
      expect(prompts[1]).toContain("Answer in French.");
      expect(prompts[1]).toContain("<name>deploy</name>");
    } finally {
      await agent.close();
    }
  });

  it("reads only what the configuration declares: a skill beside it, undeclared, is not a capability", async () => {
    const { dir, config } = layout({}, { "skills/hidden/SKILL.md": skill("hidden"), "AGENTS.md": "Undeclared.\n" });
    const { agent, ask, prompts } = await openAgentOn(dir, source(config, {}));
    try {
      await ask("hi");
      expect(prompts[0]).not.toContain("hidden");
      expect(prompts[0]).not.toContain("Undeclared.");
    } finally {
      await agent.close();
    }
  });

  it("reports a declared path that goes missing while it runs, once, and keeps reading the rest", async () => {
    const warnings: string[] = [];
    vi.spyOn(log, "warn").mockImplementation((message) => warnings.push(message));
    const { dir, config } = layout(
      { "skills/triage/SKILL.md": skill("triage") },
      { "extra-skills/audit/SKILL.md": skill("audit"), "notes.md": "Rules.\n" },
    );
    const values = { skills: ["./extra-skills"], instructions: ["./notes.md"] };
    const { agent, ask, prompts } = await openAgentOn(dir, source(config, values));
    try {
      rmSync(join(config, "extra-skills"), { recursive: true });
      rmSync(join(config, "notes.md"));
      await ask("hi");
      await ask("again");
      expect(prompts[1]).toContain("<name>triage</name>");
      expect(prompts[1]).not.toContain("<name>audit</name>");
      const gone = warnings.filter((w) => w.includes("declares it, and it is gone"));
      expect(gone.map((w) => w.replace("[fastagent] ", "").split(": ")[0]).sort()).toEqual(
        [join(config, "extra-skills"), join(config, "notes.md")].sort(),
      );
    } finally {
      await agent.close();
    }
  });

  it("skips an instance's skill that takes a program's name once it appears later, and the program's stays", async () => {
    const warnings: string[] = [];
    vi.spyOn(log, "warn").mockImplementation((message) => warnings.push(message));
    const { dir, config } = layout(
      { "skills/triage/SKILL.md": skill("triage", "From the program.") },
      { "extra-skills/.keep": "" },
    );
    const { agent, ask, prompts } = await openAgentOn(dir, source(config, { skills: ["./extra-skills"] }));
    try {
      write(config, { "extra-skills/mine/SKILL.md": skill("triage", "From the instance.") });
      await ask("hi");
      expect(prompts[0]).toContain("From the program.");
      expect(prompts[0]).not.toContain("From the instance.");
      expect(warnings.some((w) => w.includes('skill "triage" is declared by'))).toBe(true);
    } finally {
      await agent.close();
    }
  });
});

describe("opening an instance's text", () => {
  const refused = (dir: string, config: string, values: object, message: string | RegExp) =>
    expect(() => openText(dir, source(config, values))).toThrow(message);

  it("resolves a path against the configuration's directory, and refuses a relative one in an object", () => {
    const { dir, config } = layout({}, { "notes.md": "x\n", "s/.keep": "" });
    expect(openText(dir, source(config, { instructions: ["notes.md"], skills: ["s"] }))).toMatchObject({
      instructions: [{ path: join(config, "notes.md") }],
      skills: [{ path: join(dir, "skills") }, { path: join(config, "s"), declaredBy: join(config, "fastagent.json") }],
    });
    const anObject = { values: { instructions: ["notes.md"] }, label: "the config object" };
    expect(() => openText(dir, anObject)).toThrow(
      'the config object: instructions "notes.md" must be absolute here, since the config object is not a file',
    );
    expect(
      openText(dir, { ...anObject, values: { instructions: [join(config, "notes.md")] } }).instructions,
    ).toHaveLength(1);
  });

  it("refuses a path that is not what its kind names", () => {
    const { dir, config } = layout({}, { "notes.md": "x\n", "d/.keep": "" });
    refused(dir, config, { instructions: ["./nope.md"] }, 'instructions "./nope.md"');
    refused(dir, config, { instructions: ["./d"] }, /is not a file/);
    refused(dir, config, { skills: ["./notes.md"] }, /is not a directory/);
    refused(dir, config, { prompts: ["./nope"] }, /is not a directory/);
  });

  it("refuses text the program loads already, which would load twice", () => {
    const { dir, config } = layout({
      "AGENTS.md": "a\n",
      "skills/triage/SKILL.md": skill("triage"),
      "prompts/p.md": "p\n",
    });
    const same = join(dir, "AGENTS.md");
    refused(dir, config, { instructions: [same] }, /is the program's own text \(.*AGENTS\.md\), which loads already/);
    refused(dir, config, { skills: [join(dir, "skills")] }, /is the program's own text/);
    refused(dir, config, { skills: [join(dir, "skills/triage")] }, /is the program's own text/);
    refused(dir, config, { prompts: [join(dir, "prompts")] }, /is the program's own text/);
  });

  it("refuses an instance skill or prompt template that takes a name the program, or another entry of the instance, has", () => {
    const { dir, config } = layout(
      { "skills/triage/SKILL.md": skill("triage"), "prompts/plan.md": "p\n" },
      {
        "a/triage/SKILL.md": skill("triage"),
        "b/other/SKILL.md": skill("other"),
        "c/other/SKILL.md": skill("other"),
        "pa/plan.md": "x\n",
        "pb/new.md": "x\n",
        "pc/new.md": "x\n",
      },
    );
    refused(
      dir,
      config,
      { skills: ["./a"] },
      /skill "triage" is declared by .*program.*triage.*SKILL\.md and .*a.*triage.*name it otherwise/,
    );
    refused(dir, config, { skills: ["./b", "./c"] }, /skill "other" is declared by/);
    refused(dir, config, { prompts: ["./pa"] }, /prompt template "plan" is declared by/);
    refused(dir, config, { prompts: ["./pb", "./pc"] }, /prompt template "new" is declared by/);
    expect(() => openText(dir, source(config, { skills: ["./b"], prompts: ["./pb"] }))).not.toThrow();
  });
});

describe("an instance's text through the entries that open an instance", () => {
  const files = {
    "fastagent.json": JSON.stringify({ skills: ["./dev/skills"], prompts: ["./dev/prompts"] }),
    "dev/skills/audit/SKILL.md": skill("audit"),
    "dev/prompts/review.md": "Review.\n",
  };

  it("`openAgent` reads the configuration file's text, and refuses an open its names contradict", async () => {
    const { dir, config } = layout({ "skills/triage/SKILL.md": skill("triage") }, files);
    const definition = await loadSourceDefinition(dir);
    const agent = await openAgent(definition, {
      root: join(config, "root"),
      config: join(config, "fastagent.json"),
      secrets: {},
      offline: true,
    });
    try {
      expect((await agent.info()).commands.map((c) => c.name)).toEqual(["review", "skill:triage", "skill:audit"]);
    } finally {
      await agent.close();
    }
    write(config, { "dev/skills/again/SKILL.md": skill("triage") });
    await expect(
      openAgent(definition, { root: join(config, "root"), config: join(config, "fastagent.json"), secrets: {} }),
    ).rejects.toThrow(/skill "triage" is declared by/);
  });

  it("`info` lists the instance's commands from the development project's fastagent.json", async () => {
    const { dir } = layout(
      { "skills/triage/SKILL.md": skill("triage"), "fastagent.config.ts": "export default {};\n" },
      {},
    );
    write(dir, files);
    const info = await runInProcess(["info", "--json"], dir);
    expect(info.code, info.stderr).toBe(0);
    expect(JSON.parse(info.stdout).commands.map((c: { name: string }) => c.name)).toEqual([
      "review",
      "skill:triage",
      "skill:audit",
    ]);
  });
});
