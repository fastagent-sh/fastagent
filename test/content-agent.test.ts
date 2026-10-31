/**
 * An agent with content, end to end: what the model is told, what it reads, what its tools see, and that every
 * reader of the declaration — the opener, `info`, `content list` — reads the same resolution.
 */
import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryCredentialStore, type Provider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { modelsOver } from "../src/harnesses/models/models.ts";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { type ResolvedContent, resolveContent } from "../src/content/resolve.ts";
import { type ContentBinding, declareBindings } from "../src/content/declare.ts";
import { buildDefinition, assembleAgent, prepareDefinition } from "../src/harnesses/pi-durable/open.ts";
import { openServing } from "../src/harnesses/pi-durable/serve.ts";
import { makeFaux, sentPrompt } from "./faux.ts";
import { CODEX_MODEL } from "./codex-model.ts";

/** Send one message to the agent in `agentDir`, opened on `provider` with `content`. */
async function askOnce(agentDir: string, provider: Provider, content?: readonly ResolvedContent[]): Promise<void> {
  const definition = await prepareDefinition(agentDir);
  const agent = await assembleAgent(definition, {
    storage: new MemoryStorage(),
    code: { ...buildDefinition(definition, {}), providers: [provider] },
    models: modelsOver(new InMemoryCredentialStore(), [provider]),
    model: "faux/faux-1",
    ...(content === undefined ? {} : { content }),
  });
  try {
    await agent.messages.send({ sessionId: (await agent.sessions.create()).id, content: "hi" }, { wait: 30 });
  } finally {
    await agent.close();
  }
}

async function skill(dir: string, name: string, description: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nBody.\n`);
}

/** This machine's bindings of the agent in `agentDir`, as `content add <dir>` writes them. */
async function bind(agentDir: string, content: Record<string, ContentBinding>): Promise<void> {
  await writeFile(join(agentDir, "context.local.json"), JSON.stringify({ content }));
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
  await skill(join(app, ".pi", "skills", "release"), "release", "Cut a release of the app.");
  await skill(join(app, ".agents", "skills", "migrate"), "migrate", "Migrate the app's database.");
  await skill(join(agentDir, "skills", "deploy"), "deploy", "The agent's own deploy.");
  return { root, agentDir, app, handbook };
}

describe("an agent with content", () => {
  it("is told where it is and what it works on; what a project holds stays in the project", async () => {
    const { agentDir, app, handbook } = await layout();
    const content = resolveContent(agentDir, {
      declared: [],
      bound: declareBindings(
        { app: { path: app }, handbook: { path: handbook, readonly: true, description: "The team's style rules." } },
        [],
        agentDir,
      ),
    });
    const { faux } = makeFaux();
    let prompt = "";
    faux.setResponses([
      (context) => {
        prompt = sentPrompt(context);
        return fauxAssistantMessage("done");
      },
    ]);
    await askOnce(agentDir, faux.provider, content);

    expect(prompt).toContain(`Your working directory, ${agentDir}, is your own directory`);
    expect(prompt).toContain(`You work on:\n- app: ${app} (a directory on this machine)`);
    expect(prompt).toContain(
      `You know, and do not write:\n- handbook: ${handbook} (a directory on this machine) The team's style rules.`,
    );
    // The definition is the agent's own: its AGENTS.md and skills are in the prompt, and a project's AGENTS.md and
    // skills are files in the project, read when the agent works there.
    expect(prompt).toContain("OWN-AGENTS");
    expect(prompt).toContain("<name>deploy</name>");
    for (const fromContent of ["APP-AGENTS", "HANDBOOK-AGENTS", "Cut a release", "Migrate the app"]) {
      expect(prompt).not.toContain(fromContent);
    }
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
    const content = resolveContent(agentDir, {
      declared: [],
      bound: declareBindings({ handbook: { path: handbook, readonly: true } }, [], agentDir),
    });
    await askOnce(agentDir, faux.provider, content);
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
    await askOnce(agentDir, faux.provider);
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
  it("the opener, `info --json` and `content list --json` change together when the bindings do", async () => {
    // A second derivation of where the content is would disagree with this one sooner or later; here every
    // reader is asked after each change of the bindings.
    const { root, agentDir, app, handbook } = await layout();
    await writeFile(join(agentDir, "fastagent.config.ts"), `export default {\n  model: "${CODEX_MODEL}",\n};\n`);
    await bind(agentDir, { app: { path: "../app" } });
    const readers = async () => {
      const opened = await openServing(agentDir, { storage: "memory" });
      await opened.agent.close();
      const info = JSON.parse((await cli(["info", "--json"], agentDir)).stdout);
      const list = JSON.parse((await cli(["content", "list", "--json"], agentDir)).stdout);
      return [opened.content, info.content, list.content];
    };
    const entry = (name: string, location: string, readonly = false) => ({
      name,
      kind: "local",
      readonly,
      location,
      notices: [],
    });
    const first = [entry("app", app)];
    expect(await readers()).toEqual([first, first, first]);

    const added = await cli(["content", "add", handbook, agentDir, "--readonly"], root);
    expect(added.code, added.stderr).toBe(0);
    expect(added.stderr).toContain(`knows handbook  ${handbook} (this machine only, bound in context.local.json)`);
    const second = [...first, entry("handbook", handbook, true)];
    expect(await readers()).toEqual([second, second, second]);
    // This machine's file holds the paths, the one written by hand as it was; the shared file is not written.
    expect(JSON.parse(await readFile(join(agentDir, "context.local.json"), "utf8"))).toEqual({
      content: { app: { path: "../app" }, handbook: { path: handbook, readonly: true } },
    });
    await expect(lstat(join(agentDir, "context.json"))).rejects.toThrow(/ENOENT/);

    const removed = await cli(["content", "remove", "APP", agentDir], root);
    expect(removed.code, removed.stderr).toBe(0);
    const third = [entry("handbook", handbook, true)];
    expect(await readers()).toEqual([third, third, third]);
    // The directory it was bound to stays.
    expect((await lstat(app)).isDirectory()).toBe(true);

    // A bound directory that is gone is no reader's content, and `content list --json` names it.
    await bind(agentDir, { gone: { path: join(root, "gone") } });
    const listed = JSON.parse((await cli(["content", "list", "--json"], agentDir)).stdout);
    expect(listed).toEqual({
      content: [],
      absent: [{ name: "gone", path: join(root, "gone"), kind: "local", readonly: false }],
    });
  });

  it("`content add` asks for a name it cannot take, and refuses content around the agent", async () => {
    const { root, agentDir, app } = await layout();
    await writeFile(join(agentDir, "fastagent.config.ts"), `export default {};\n`);
    await bind(agentDir, { app: { path: app } });
    const before = await readFile(join(agentDir, "context.local.json"), "utf8");
    const other = join(root, "elsewhere", "app");
    await mkdir(other, { recursive: true });
    const taken = await cli(["content", "add", other, agentDir], root);
    expect([taken.code, taken.stderr]).toEqual([
      2,
      expect.stringMatching(/already has content named "app" — pass --name/),
    ]);
    const around = await cli(["content", "add", root, agentDir], root);
    expect([around.code, around.stderr]).toEqual([1, expect.stringMatching(/contains the agent directory/)]);
    expect(await readFile(join(agentDir, "context.local.json"), "utf8")).toBe(before);
    const missing = await cli(["content", "remove", "nope", agentDir], root);
    expect([missing.code, missing.stderr]).toEqual([
      2,
      expect.stringMatching(/no content named "nope" \(this agent has: app\)/),
    ]);
    // With a name of its own it is added.
    const named = await cli(["content", "add", other, agentDir, "--name", "app2"], root);
    expect(named.code, named.stderr).toBe(0);
    expect(named.stderr).toContain(`works on app2  ${other} (this machine only, bound in context.local.json)`);
    expect(JSON.parse(await readFile(join(agentDir, "context.local.json"), "utf8")).content).toEqual({
      app: { path: app },
      app2: { path: other },
    });
  });
});
