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
});
