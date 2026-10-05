/**
 * An agent with contexts, end to end: what the model is told, what it reads, what its tools see, and that every
 * reader of the declaration — the opener, `info`, `context list` — reads the same resolution.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { collect, createPiAgent, createPiAgentFromDefinition, createPiAgentFromDir, defineTool } from "../src/index.ts";
import { agentOf, assemblePiFromDefinition, piAllCodingTools, resolveAgentTools } from "../src/engines/pi/create.ts";
import { loadAgentDefinition } from "../src/engines/pi/definition.ts";
import { agentCommands, resolveAgentDirs } from "../src/engines/pi/open.ts";
import { agentModels } from "../src/engines/pi/agent-models.ts";
import { type ResolvedContext, agentDirs, resolveContexts } from "../src/contexts/resolve.ts";
import { makeFaux, sentPrompt, sentTools } from "./faux.ts";

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
  await writeFile(join(agentDir, "AGENTS.md"), "OWN-AGENTS: for whoever changes the agent.\n");
  await writeFile(join(app, "AGENTS.md"), "APP-AGENTS: run the tests before committing.\n");
  await writeFile(join(handbook, "AGENTS.md"), "HANDBOOK-AGENTS: style rules.\n");
  await skill(join(app, ".pi", "skills", "deploy"), "deploy", "Deploy the app (pi spelling).");
  await skill(join(app, ".agents", "skills", "deploy"), "deploy", "Deploy the app (standard spelling).");
  await skill(join(app, ".agents", "skills", "release"), "release", "Cut a release.");
  await skill(join(app, ".agents", "skills", "slashed"), "a/b", "Named with a slash.");
  await skill(join(agentDir, "skills", "deploy"), "deploy", "The agent's own deploy.");
  return { root, agentDir, app, handbook };
}

describe("an agent with contexts", () => {
  it("is told where it is and what it works on, reads each context's AGENTS.md and skills, and its tools see them", async () => {
    const { agentDir, app, handbook } = await layout();
    const contexts = resolveContexts(agentDir, [{ local: app }, { local: handbook, readonly: true }], {
      place: "local",
    });
    const { faux } = makeFaux();
    let prompt = "";
    let seen: readonly ResolvedContext[] | undefined;
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
      description: "Report the contexts.",
      input: z.object({}),
      execute: (_input, ctx) => {
        seen = ctx.contexts;
        return "ok";
      },
    });
    const { agent } = await createPiAgentFromDefinition(agentDir, {
      model: "faux/faux-1",
      providers: [faux.provider],
      contexts,
      tools: [...piAllCodingTools(agentDir), where],
    });
    await collect(agent.invoke({ session: "s" }, { text: "hi" }));

    expect(prompt).toContain(`Your working directory, ${agentDir}, is your own directory`);
    expect(prompt).toContain(`You work on:\n- app: ${app} (a directory on this machine)`);
    expect(prompt).toContain(`You know, and do not write:\n- handbook: ${handbook} (a directory on this machine)`);
    // Each context's root AGENTS.md is project context; the agent's own is not loaded.
    expect(prompt).toContain("APP-AGENTS");
    expect(prompt).toContain("HANDBOOK-AGENTS");
    expect(prompt).not.toContain("OWN-AGENTS");
    // A context's skills carry its name, so the agent's own `deploy` and the app's never collide.
    expect(prompt).toContain("<name>deploy</name>");
    expect(prompt).toContain("<name>app/deploy</name>");
    expect(prompt).toContain("Deploy the app (pi spelling).");
    expect(prompt).not.toContain("standard spelling");
    expect(prompt).toContain("<name>app/release</name>");
    expect(seen).toEqual(contexts);

    // Inside one context, `.pi/skills` wins over `.agents/skills`, and the loser is reported like any two places
    // holding one name; a project skill named with a slash is left out and said.
    const definition = await loadAgentDefinition(agentDir, { contexts });
    expect(definition.collisions).toEqual([
      expect.objectContaining({ name: "app/deploy", loserPath: join(app, ".agents", "skills", "deploy", "SKILL.md") }),
    ]);
    expect(definition.ignored).toContainEqual({
      path: join(app, ".agents", "skills", "slashed", "SKILL.md"),
      reason: `not loaded: a skill's name may not contain "/" ("a/b")`,
    });
  });

  it("with only contexts it knows, it is told to write in its own directory, not in a context it works on", async () => {
    const { agentDir, handbook } = await layout();
    const { faux } = makeFaux();
    let prompt = "";
    faux.setResponses([
      (context) => {
        prompt = sentPrompt(context);
        return fauxAssistantMessage("ok");
      },
    ]);
    const contexts = resolveContexts(agentDir, [{ local: handbook, readonly: true }], { place: "local" });
    const { agent } = await createPiAgentFromDefinition(agentDir, {
      model: "faux/faux-1",
      providers: [faux.provider],
      contexts,
    });
    await collect(agent.invoke({ session: "s" }, { text: "hi" }));
    expect(prompt).toContain("You write only in your own directory: the contexts above are for reading.");
    expect(prompt).not.toContain("You work on:");
    expect(prompt).not.toContain("belongs in a context you work on");
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
    expect(prompt).toContain("You have no contexts: you work only in your own directory.");
    expect(prompt).not.toContain("<project_context>");
  });
});

/** An agent whose working directory is a context, `work`, holding a `.pi/` of its own. */
async function workLayout() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fa-workdir-")));
  const agentDir = join(root, "agent");
  const work = join(root, "work");
  await mkdir(agentDir);
  await writeFile(join(agentDir, "APPEND_SYSTEM.md"), "OWN-APPEND.\n");
  await mkdir(join(work, ".pi", "prompts"), { recursive: true });
  await mkdir(join(work, ".pi", "extensions"), { recursive: true });
  await writeFile(join(work, ".pi", "APPEND_SYSTEM.md"), "WORK-APPEND.\n");
  // Read as project settings, this would turn codemode off.
  await writeFile(join(work, ".pi", "settings.json"), JSON.stringify({ extensions: ["-builtin:codemode"] }));
  await writeFile(join(work, ".pi", "prompts", "wp.md"), "---\ndescription: from the working directory\n---\nHi\n");
  await writeFile(join(work, ".pi", "extensions", "stray.ts"), "globalThis.__fa_workdir_stray__ = true;\n");
  await skill(join(work, ".pi", "skills", "tidy"), "tidy", "Tidy the notes.");
  const contexts = resolveContexts(agentDir, [{ local: work, workdir: true }], { place: "local" });
  return { root, agentDir, work, contexts };
}

describe("an agent with a working directory", () => {
  it("works there and is told where its definition is; what is the agent's stays read from the agent directory", async () => {
    const { agentDir, work, contexts } = await workLayout();
    const { faux } = makeFaux();
    let prompt = "";
    let tools: string[] = [];
    let seen: { cwd: string; agentDir: string } | undefined;
    faux.setResponses([
      (context) => {
        prompt = sentPrompt(context);
        tools = sentTools(context);
        return {
          ...fauxAssistantMessage(""),
          content: [
            { type: "toolCall", id: "w", name: "write", arguments: { path: "out.txt", content: "made" } },
            { type: "toolCall", id: "c", name: "where", arguments: {} },
          ],
        } as ReturnType<typeof fauxAssistantMessage>;
      },
      fauxAssistantMessage("done"),
    ]);
    const where = defineTool({
      name: "where",
      description: "Report the directories.",
      input: z.object({}),
      execute: (_input, ctx) => {
        seen = { cwd: ctx.cwd, agentDir: ctx.agentDir };
        return "ok";
      },
    });
    const scripted = defineTool({
      name: "scripted",
      description: "Reached through codemode.",
      input: z.object({}),
      exposure: "codemode",
      execute: () => "ok",
    });
    // The opener's tool set: the coding tools rooted where the agent works.
    const { tools: mounted } = await resolveAgentTools({ tools: [where, scripted] }, agentDirs(agentDir, contexts));
    const { agent } = await createPiAgentFromDefinition(agentDir, {
      model: "faux/faux-1",
      providers: [faux.provider],
      contexts,
      tools: mounted,
    });
    await collect(agent.invoke({ session: "s" }, { text: "hi" }));

    expect(prompt).toContain(`Your working directory is ${work}, the context work`);
    expect(prompt).toContain(`Your own definition is at ${agentDir}: change yourself there, by its full path.`);
    expect(prompt).toContain(`- work: ${work} (a directory on this machine; your working directory)`);
    expect(prompt).toContain("not in your definition.");
    // A relative path lands where the agent works; a tool is told both directories.
    expect(await readFile(join(work, "out.txt"), "utf8")).toBe("made");
    expect(existsSync(join(agentDir, "out.txt"))).toBe(false);
    expect(seen).toEqual({ cwd: work, agentDir });
    // The definition is the agent directory's. The working directory is a context: its skills are named for it, and
    // nothing else of its `.pi/` applies (settings, prompt files, prompt templates, extensions).
    expect(prompt).toContain("OWN-APPEND");
    expect(prompt).not.toContain("WORK-APPEND");
    expect(prompt).toContain("<name>work/tidy</name>");
    expect(prompt).not.toContain("<name>tidy</name>");
    expect(tools).toContain("codemode");
    expect((globalThis as Record<string, unknown>).__fa_workdir_stray__).toBeUndefined();
    const menu = await agentCommands(agentDirs(agentDir, contexts), contexts, {
      extensionPaths: [],
      modelRuntime: agentModels(agentDirs(agentDir, contexts), {}, { providers: [faux.provider] }).createRuntime,
    });
    expect(menu.map((command) => command.name)).not.toContain("wp");
  });

  it("imports each extension once, across turns and the `/` menu", async () => {
    // pi caches loaded extensions for ONE cwd and imports every module again when a load names another: a menu built
    // on the agent directory beside turns in the working directory would re-run `extensions/` each time.
    const { agentDir, contexts } = await workLayout();
    const key = `__fa_workdir_ext_${Date.now()}__`;
    await mkdir(join(agentDir, "extensions"));
    await writeFile(
      join(agentDir, "extensions", "count.ts"),
      `globalThis[${JSON.stringify(key)}] = (globalThis[${JSON.stringify(key)}] ?? 0) + 1;\n` +
        `export default (pi) => { pi.registerCommand("hello", { description: "Say hello.", handler: async () => {} }); };\n`,
    );
    const { faux } = makeFaux();
    faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
    const { assembly } = await assemblePiFromDefinition(agentDir, {
      model: "faux/faux-1",
      providers: [faux.provider],
      contexts,
    });
    const agent = agentOf(assembly);
    const imports = () => (globalThis as unknown as Record<string, number>)[key];
    await collect(agent.invoke({ session: "s" }, { text: "hi" }));
    expect(imports()).toBe(1);
    const menu = await agentCommands(agentDirs(agentDir, contexts), contexts, {
      extensionPaths: assembly.extensionPaths,
      modelRuntime: assembly.createModelRuntime,
    });
    expect(menu.map((command) => command.name)).toContain("hello");
    await collect(agent.invoke({ session: "s" }, { text: "again" }));
    expect(imports()).toBe(1);
  });

  it("a caller that needs only where the agent works gets it without its contexts existing", async () => {
    // A model list or a login loads the agent's extensions where it works; whether a context is there is for the
    // commands that run the agent to refuse.
    const root = await realpath(await mkdtemp(join(tmpdir(), "fa-workdir-dirs-")));
    const agentDir = join(root, "agent");
    await mkdir(agentDir);
    await writeFile(
      join(agentDir, "fastagent.config.ts"),
      `export default {\n  contexts: [{ local: "../gone" }, { local: "../work", workdir: true }],\n};\n`,
    );
    expect(await resolveAgentDirs(agentDir)).toEqual({ agentDir, cwd: join(root, "work") });
    await expect(createPiAgentFromDir(agentDir)).rejects.toThrow(/context "gone": .* does not exist/);
  });

  it("at L1, which has no agent directory, a tool's agentDir is its cwd", async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "fa-l1-dirs-")));
    const { faux } = makeFaux();
    let seen: { cwd: string; agentDir: string } | undefined;
    faux.setResponses([
      {
        ...fauxAssistantMessage(""),
        content: [{ type: "toolCall", id: "c", name: "where", arguments: {} }],
      } as ReturnType<typeof fauxAssistantMessage>,
      fauxAssistantMessage("done"),
    ]);
    const where = defineTool({
      name: "where",
      description: "Report the directories.",
      input: z.object({}),
      execute: (_input, ctx) => {
        seen = { cwd: ctx.cwd, agentDir: ctx.agentDir };
        return "ok";
      },
    });
    const agent = createPiAgent({
      model: "faux/faux-1",
      providers: [faux.provider],
      tools: [where],
      env: new NodeExecutionEnv({ cwd }),
    });
    await collect(agent.invoke({ session: "s" }, { text: "hi" }));
    expect(seen).toEqual({ cwd, agentDir: cwd });
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
  it("the opener, `info --json` and `context list --json` change together when the declaration does", async () => {
    // A second derivation of where the contexts are would disagree with this one sooner or later; here every
    // reader is asked after each change of the declaration.
    const { root, agentDir, app, handbook } = await layout();
    await writeFile(
      join(agentDir, "fastagent.config.ts"),
      `export default {\n  model: "openai-codex/gpt-5.5",\n  contexts: [\n    { local: "../app", copy: true },\n  ],\n};\n`,
    );
    const readers = async () => {
      const opened = await createPiAgentFromDir(agentDir);
      const info = JSON.parse((await cli(["info", "--json"], agentDir)).stdout);
      const list = JSON.parse((await cli(["context", "list", "--json"], agentDir)).stdout);
      return [opened.contexts, info.contexts, list];
    };
    const first = [{ name: "app", kind: "copy", readonly: false, workdir: false, location: app }];
    expect(await readers()).toEqual([first, first, first]);

    const added = await cli(["context", "add", handbook, agentDir, "--readonly", "--copy"], root);
    expect(added.code, added.stderr).toBe(0);
    expect(added.stderr).toContain(`knows handbook  ${handbook} (local, copied to a host)`);
    const second = [...first, { name: "handbook", kind: "copy", readonly: true, workdir: false, location: handbook }];
    expect(await readers()).toEqual([second, second, second]);
    // The edit is the literal list, absolute, as `init` writes it; the hand-written relative path stays as written.
    expect(await readFile(join(agentDir, "fastagent.config.ts"), "utf8")).toContain(
      `    { local: "../app", copy: true },\n    { local: ${JSON.stringify(handbook)}, copy: true, readonly: true },\n`,
    );

    const removed = await cli(["context", "remove", "APP", agentDir], root);
    expect(removed.code, removed.stderr).toBe(0);
    const third = [{ name: "handbook", kind: "copy", readonly: true, workdir: false, location: handbook }];
    expect(await readers()).toEqual([third, third, third]);
  });

  it("`fastagent tool` hands a tool both directories, from the same resolution as a turn", async () => {
    const { root, agentDir } = await layout();
    const work = join(root, "work");
    await mkdir(work);
    const index = new URL("../src/index.ts", import.meta.url).href;
    await writeFile(
      join(agentDir, "fastagent.config.ts"),
      `export default {\n  contexts: [{ local: "../work", workdir: true }],\n};\n`,
    );
    await mkdir(join(agentDir, "tools"));
    await writeFile(
      join(agentDir, "tools", "where.ts"),
      `import { defineTool, z } from ${JSON.stringify(index)};\n` +
        `export default defineTool({ description: "Where.", input: z.object({}), ` +
        `execute: (_input, ctx) => JSON.stringify({ cwd: ctx.cwd, agentDir: ctx.agentDir }) });\n`,
    );
    const ran = await cli(["tool", "where", "{}", agentDir], root);
    expect(ran.code, ran.stderr).toBe(0);
    expect(JSON.parse(ran.stdout)).toEqual({ cwd: work, agentDir });
  });

  it("`context add --workdir` makes a missing directory and declares it; a refusal leaves no directory behind", async () => {
    const { root, agentDir } = await layout();
    await writeFile(join(agentDir, "fastagent.config.ts"), `export default {\n  contexts: [],\n};\n`);
    const fresh = join(root, "new", "work");
    const added = await cli(["context", "add", fresh, agentDir, "--workdir"], root);
    expect(added.code, added.stderr).toBe(0);
    expect(added.stderr).toContain(`created ${fresh}`);
    expect(added.stderr).toContain(`works in work  ${fresh} (local, this machine only)`);
    expect(await readFile(join(agentDir, "fastagent.config.ts"), "utf8")).toContain(
      `    { local: ${JSON.stringify(fresh)}, workdir: true },\n`,
    );
    // A second working directory is refused before anything is made.
    const second = join(root, "second", "work");
    const refused = await cli(["context", "add", second, agentDir, "--workdir", "--name", "two"], root);
    expect([refused.code, refused.stderr]).toEqual([1, expect.stringMatching(/an agent has one working directory/)]);
    expect(existsSync(join(root, "second"))).toBe(false);
  });

  it("`context add` asks for a name it cannot take, and refuses a context around the agent", async () => {
    const { root, agentDir, app } = await layout();
    await writeFile(
      join(agentDir, "fastagent.config.ts"),
      `export default {\n  contexts: [{ local: "../app" }],\n};\n`,
    );
    const before = await readFile(join(agentDir, "fastagent.config.ts"), "utf8");
    const other = join(root, "elsewhere", "app");
    await mkdir(other, { recursive: true });
    const taken = await cli(["context", "add", other, agentDir], root);
    expect([taken.code, taken.stderr]).toEqual([
      2,
      expect.stringMatching(/already has a context named "app" — pass --name/),
    ]);
    const around = await cli(["context", "add", root, agentDir], root);
    expect([around.code, around.stderr]).toEqual([1, expect.stringMatching(/contains the agent directory/)]);
    expect(await readFile(join(agentDir, "fastagent.config.ts"), "utf8")).toBe(before);
    const missing = await cli(["context", "remove", "nope", agentDir], root);
    expect([missing.code, missing.stderr]).toEqual([
      2,
      expect.stringMatching(/no context named "nope" \(this agent has: app\)/),
    ]);
    // With a name of its own it is added, and without --copy a host gets none of it.
    const named = await cli(["context", "add", other, agentDir, "--name", "app2"], root);
    expect(named.code, named.stderr).toBe(0);
    expect(named.stderr).toContain(`works on app2  ${other} (local, this machine only)`);
    expect(await readFile(join(agentDir, "fastagent.config.ts"), "utf8")).toContain(
      `    { local: ${JSON.stringify(other)}, name: "app2" },\n`,
    );
    expect(app).toBeDefined();
  });
});
