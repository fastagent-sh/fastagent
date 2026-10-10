/**
 * An agent with content, end to end: what the model is told, what it reads, what its tools see, and that every
 * reader of the declaration — the opener, `info`, `content list` — reads the same resolution.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { collect, createPiAgentFromDefinition, createPiAgentFromDir, defineTool } from "../src/index.ts";
import { piAllCodingTools } from "../src/harnesses/pi/create.ts";
import { loadAgentDefinition } from "../src/harnesses/pi/definition.ts";
import { type ResolvedContent, resolveContent } from "../src/content/resolve.ts";
import { makeFaux, sentPrompt } from "./faux.ts";

async function skill(dir: string, name: string, description: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nBody.\n`);
}

/** An agent beside two projects: `app` it works on, `handbook` it knows. */
async function layout() {
  // Real, because the CLI runs with this as its cwd and reports the spelling the process sees.
  const root = await realpath(await mkdtemp(join(tmpdir(), "fa-ctx-agent-")));
  const agentDir = join(root, "agent");
  const app = join(root, "app");
  const handbook = join(root, "handbook");
  for (const dir of [agentDir, app, handbook]) await mkdir(dir);
  await writeFile(join(agentDir, "AGENTS.md"), "OWN-AGENTS: how this agent is built and changed.\n");
  await writeFile(join(app, "AGENTS.md"), "APP-AGENTS: run the tests before committing.\n");
  await writeFile(join(handbook, "AGENTS.md"), "HANDBOOK-AGENTS: style rules.\n");
  await skill(join(app, ".pi", "skills", "deploy"), "deploy", "Deploy the app (pi spelling).");
  await skill(join(app, ".agents", "skills", "deploy"), "deploy", "Deploy the app (standard spelling).");
  await skill(join(app, ".agents", "skills", "release"), "release", "Cut a release.");
  await skill(join(app, ".agents", "skills", "slashed"), "a/b", "Named with a slash.");
  await skill(join(agentDir, "skills", "deploy"), "deploy", "The agent's own deploy.");
  return { root, agentDir, app, handbook };
}

describe("an agent with content", () => {
  it("is told where it is and what it works on, reads each entry's AGENTS.md and skills, and its tools see them", async () => {
    const { agentDir, app, handbook } = await layout();
    const content = resolveContent(agentDir, [{ local: app }, { local: handbook, readonly: true }], "local");
    const { faux } = makeFaux();
    let prompt = "";
    let seen: readonly ResolvedContent[] | undefined;
    faux.setResponses([
      (context) => {
        prompt = sentPrompt(context);
        return {
          ...fauxAssistantMessage(""),
          content: [{ type: "toolCall", id: "c1", name: "where", arguments: {} }],
        } as ReturnType<typeof fauxAssistantMessage>;
      },
      fauxAssistantMessage("done"),
    ]);
    const where = defineTool({
      name: "where",
      description: "Report the content.",
      input: z.object({}),
      execute: (_input, ctx) => {
        seen = ctx.content;
        return "ok";
      },
    });
    const { agent } = await createPiAgentFromDefinition(agentDir, {
      model: "faux/faux-1",
      providers: [faux.provider],
      content,
      tools: [...piAllCodingTools(agentDir), where],
    });
    await collect(agent.invoke({ session: "s" }, { text: "hi" }));

    expect(prompt).toContain(`Your working directory, ${agentDir}, is your own directory`);
    expect(prompt).toContain(`You work on:\n- app: ${app} (a directory on this machine)`);
    expect(prompt).toContain(`You know, and do not write:\n- handbook: ${handbook} (a directory on this machine)`);
    // The agent's own AGENTS.md is project context first, then each content entry's root one, in declaration order.
    expect(prompt.indexOf("OWN-AGENTS")).toBeGreaterThan(-1);
    expect(prompt.indexOf("OWN-AGENTS")).toBeLessThan(prompt.indexOf("APP-AGENTS"));
    expect(prompt.indexOf("APP-AGENTS")).toBeLessThan(prompt.indexOf("HANDBOOK-AGENTS"));
    // A content entry's skills carry its name, so the agent's own `deploy` and the app's never collide.
    expect(prompt).toContain("<name>deploy</name>");
    expect(prompt).toContain("<name>app/deploy</name>");
    expect(prompt).toContain("Deploy the app (pi spelling).");
    expect(prompt).not.toContain("standard spelling");
    expect(prompt).toContain("<name>app/release</name>");
    expect(seen).toEqual(content);

    // Inside one entry, `.pi/skills` wins over `.agents/skills`, and the loser is reported like any two places
    // holding one name; a project skill named with a slash is left out and said.
    const definition = await loadAgentDefinition(agentDir, { content });
    expect(definition.collisions).toEqual([
      expect.objectContaining({ name: "app/deploy", loserPath: join(app, ".agents", "skills", "deploy", "SKILL.md") }),
    ]);
    expect(definition.ignored).toContainEqual({
      path: join(app, ".agents", "skills", "slashed", "SKILL.md"),
      reason: `not loaded: a skill's name may not contain "/" ("a/b")`,
    });
  });

  it("with only content it knows, it is told to write in its own directory, not in a directory it works on", async () => {
    const { agentDir, handbook } = await layout();
    const { faux } = makeFaux();
    let prompt = "";
    faux.setResponses([
      (context) => {
        prompt = sentPrompt(context);
        return fauxAssistantMessage("ok");
      },
    ]);
    const content = resolveContent(agentDir, [{ local: handbook, readonly: true }], "local");
    const { agent } = await createPiAgentFromDefinition(agentDir, {
      model: "faux/faux-1",
      providers: [faux.provider],
      content,
    });
    await collect(agent.invoke({ session: "s" }, { text: "hi" }));
    expect(prompt).toContain("You write only in your own directory: the directories above are for reading.");
    expect(prompt).not.toContain("You work on:");
    expect(prompt).not.toContain("belongs in a directory you work on");
  });

  it("with none, it is told it works only in its own directory", async () => {
    const { agentDir } = await layout();
    const { faux } = makeFaux();
    let prompt = "";
    faux.setResponses([
      (context) => {
        prompt = sentPrompt(context);
        return fauxAssistantMessage("ok");
      },
    ]);
    const { agent } = await createPiAgentFromDefinition(agentDir, { model: "faux/faux-1", providers: [faux.provider] });
    await collect(agent.invoke({ session: "s" }, { text: "hi" }));
    expect(prompt).toContain("Nothing else is declared for you: you work only in your own directory.");
    expect(prompt).toContain("OWN-AGENTS"); // its own AGENTS.md is its project context still
  });
});

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function cli(args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("one resolution", () => {
  it("the opener, `info --json` and `content list --json` change together when the declaration does", async () => {
    // A second derivation of where the content are would disagree with this one sooner or later; here every
    // reader is asked after each change of the declaration.
    const { root, agentDir, app, handbook } = await layout();
    await writeFile(
      join(agentDir, "fastagent.config.ts"),
      `export default {\n  model: "openai-codex/gpt-5.5",\n  content: [\n    { local: "../app" },\n  ],\n};\n`,
    );
    const readers = async () => {
      const opened = await createPiAgentFromDir(agentDir);
      const info = JSON.parse((await cli(["info", "--json"], agentDir)).stdout);
      const list = JSON.parse((await cli(["content", "list", "--json"], agentDir)).stdout);
      return [opened.content, info.content, list];
    };
    const first = [{ name: "app", kind: "local", readonly: false, location: app, notices: [] }];
    expect(await readers()).toEqual([first, first, first]);

    const added = await cli(["content", "add", handbook, agentDir, "--readonly"], root);
    expect(added.code, added.stderr).toBe(0);
    expect(added.stderr).toContain(`knows handbook  ${handbook} (local, this machine only)`);
    const second = [...first, { name: "handbook", kind: "local", readonly: true, location: handbook, notices: [] }];
    expect(await readers()).toEqual([second, second, second]);
    // The edit is the literal list, absolute, as `init` writes it; the hand-written relative path stays as written.
    expect(await readFile(join(agentDir, "fastagent.config.ts"), "utf8")).toContain(
      `    { local: "../app" },\n    { local: ${JSON.stringify(handbook)}, readonly: true },\n`,
    );

    const removed = await cli(["content", "remove", "APP", agentDir], root);
    expect(removed.code, removed.stderr).toBe(0);
    const third = [{ name: "handbook", kind: "local", readonly: true, location: handbook, notices: [] }];
    expect(await readers()).toEqual([third, third, third]);
  });

  it("`content add` asks for a name it cannot take, and refuses content around the agent", async () => {
    const { root, agentDir, app } = await layout();
    await writeFile(join(agentDir, "fastagent.config.ts"), `export default {\n  content: [{ local: "../app" }],\n};\n`);
    const before = await readFile(join(agentDir, "fastagent.config.ts"), "utf8");
    const other = join(root, "elsewhere", "app");
    await mkdir(other, { recursive: true });
    const taken = await cli(["content", "add", other, agentDir], root);
    expect([taken.code, taken.stderr]).toEqual([
      2,
      expect.stringMatching(/already has content named "app" — pass --name/),
    ]);
    const around = await cli(["content", "add", root, agentDir], root);
    expect([around.code, around.stderr]).toEqual([1, expect.stringMatching(/contains the agent directory/)]);
    expect(await readFile(join(agentDir, "fastagent.config.ts"), "utf8")).toBe(before);
    const missing = await cli(["content", "remove", "nope", agentDir], root);
    expect([missing.code, missing.stderr]).toEqual([
      2,
      expect.stringMatching(/no content named "nope" \(this agent has: app\)/),
    ]);
    // With a name of its own it is added.
    const named = await cli(["content", "add", other, agentDir, "--name", "app2"], root);
    expect(named.code, named.stderr).toBe(0);
    expect(named.stderr).toContain(`works on app2  ${other} (local, this machine only)`);
    expect(await readFile(join(agentDir, "fastagent.config.ts"), "utf8")).toContain(
      `    { local: ${JSON.stringify(other)}, name: "app2" },\n`,
    );
    expect(app).toBeDefined();
  });
});
