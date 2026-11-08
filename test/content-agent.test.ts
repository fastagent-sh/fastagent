/**
 * An agent with content, end to end: what the model is told, what it reads, what its tools see, and that every
 * reader of the declaration — the opener, `info`, `content list` — reads the same resolution.
 */
import { resolveConfig } from "../src/harnesses/pi-durable/config.ts";
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, type Provider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { modelsOver } from "../src/harnesses/models/models.ts";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { runInProcess } from "./cli-run.ts";
import { describe, expect, it } from "vitest";
import { type ResolvedContent, resolveContent } from "../src/content/resolve.ts";
import { type ContentEntry, declareContent } from "../src/content/declare.ts";
import {
  assembleAgent,
  buildDefinition,
  loadDevProject,
  loadSourceDefinition,
} from "../src/harnesses/pi-durable/open.ts";
import { openServing } from "../src/harnesses/pi-durable/serve.ts";
import { makeFaux, sentPrompt } from "./faux.ts";
import { CODEX_MODEL } from "./codex-model.ts";

/** Send one message to the agent in `agentDir`, opened on `provider` with `content`. */
async function askOnce(agentDir: string, provider: Provider, content?: readonly ResolvedContent[]): Promise<void> {
  const definition = await loadSourceDefinition(agentDir);
  const agent = await assembleAgent(definition, {
    storage: new MemoryStorage(),
    ownEnv: process.env,
    processEnv: {},
    code: { ...buildDefinition(definition, {}), providers: [provider] },
    config: resolveConfig(definition),
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

/** The content the instance of the agent in `agentDir` adds, as `content add <dir>` writes it. */
async function bind(agentDir: string, content: Record<string, ContentEntry>): Promise<void> {
  await writeFile(join(agentDir, "fastagent.json"), JSON.stringify({ content }));
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
    const content = resolveContent(
      declareContent(
        { app: { path: app }, handbook: { path: handbook, description: "The team's style rules." } },
        { origin: "instance", file: "fastagent.json", base: agentDir },
      ),
      { dir: agentDir, workdir: agentDir },
    );
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
    expect(prompt).toContain(
      `You work on:\n- app: ${app} (a directory on this machine)\n- handbook: ${handbook} (a directory on this machine) The team's style rules.`,
    );
    // The definition is the agent's own: its AGENTS.md and skills are in the prompt, and a project's AGENTS.md and
    // skills are files in the project, read when the agent works there.
    expect(prompt).toContain("OWN-AGENTS");
    expect(prompt).toContain("<name>deploy</name>");
    for (const fromContent of ["APP-AGENTS", "HANDBOOK-AGENTS", "Cut a release", "Migrate the app"]) {
      expect(prompt).not.toContain(fromContent);
    }
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

const cli = (args: string[], cwd: string) => runInProcess(args, cwd);

describe("one resolution", () => {
  it("the opener, `info --json` and `content list --json` change together when the content does", async () => {
    // A second derivation of where the content is would disagree with this one sooner or later; here every
    // reader is asked after each change of the content.
    const { root, agentDir, app, handbook } = await layout();
    await writeFile(
      join(agentDir, "fastagent.config.ts"),
      `export default {\n  defaults: { model: "${CODEX_MODEL}" },\n};\n`,
    );
    await bind(agentDir, { app: { path: "../app" } });
    const readers = async () => {
      const { definition, instance } = await loadDevProject(agentDir);
      const opened = await openServing(definition, {
        secrets: {},
        env: {},
        ownEnv: process.env,
        storage: "memory",
        ...(instance === undefined ? {} : { config: instance }),
      });
      await opened.agent.close();
      const info = JSON.parse((await cli(["info", "--json"], agentDir)).stdout);
      const list = JSON.parse((await cli(["content", "list", "--json"], agentDir)).stdout);
      return [opened.content, info.content, list.content];
    };
    const entry = (name: string, location: string) => ({
      name,
      kind: "local",
      location,
      notices: [],
    });
    const first = [entry("app", app)];
    expect(await readers()).toEqual([first, first, first]);

    const added = await cli(["content", "add", handbook, agentDir], root);
    expect(added.code, added.stderr).toBe(0);
    expect(added.stderr).toContain(`works on handbook  ${handbook} (a directory of this machine)`);
    const second = [...first, entry("handbook", handbook)];
    expect(await readers()).toEqual([second, second, second]);
    // The instance's file holds the paths, the one written by hand as it was; the program's file is not written.
    expect(JSON.parse(await readFile(join(agentDir, "fastagent.json"), "utf8"))).toEqual({
      content: { app: { path: "../app" }, handbook: { path: handbook } },
    });
    await expect(lstat(join(agentDir, "context.json"))).rejects.toThrow(/ENOENT/);

    const removed = await cli(["content", "remove", "APP", agentDir], root);
    expect(removed.code, removed.stderr).toBe(0);
    const third = [entry("handbook", handbook)];
    expect(await readers()).toEqual([third, third, third]);
    // The directory it named stays.
    expect((await lstat(app)).isDirectory()).toBe(true);

    // A directory that is gone is refused by every reader, naming it.
    await bind(agentDir, { gone: { path: join(root, "gone") } });
    const listed = await cli(["content", "list", "--json"], agentDir);
    expect([listed.code, listed.stderr]).toEqual([
      1,
      expect.stringContaining(`content "gone": ${join(root, "gone")} does not exist`),
    ]);
  });

  it("`content add` asks for a name it cannot take, and refuses content around the agent", async () => {
    const { root, agentDir, app } = await layout();
    await writeFile(join(agentDir, "fastagent.config.ts"), `export default {};\n`);
    await bind(agentDir, { app: { path: app } });
    const before = await readFile(join(agentDir, "fastagent.json"), "utf8");
    const other = join(root, "elsewhere", "app");
    await mkdir(other, { recursive: true });
    const taken = await cli(["content", "add", other, agentDir], root);
    expect([taken.code, taken.stderr]).toEqual([
      2,
      expect.stringMatching(/already has content named "app" — pass --name/),
    ]);
    const around = await cli(["content", "add", root, agentDir], root);
    expect([around.code, around.stderr]).toEqual([1, expect.stringMatching(/contains the agent directory/)]);
    expect(await readFile(join(agentDir, "fastagent.json"), "utf8")).toBe(before);
    const missing = await cli(["content", "remove", "nope", agentDir], root);
    expect([missing.code, missing.stderr]).toEqual([
      2,
      expect.stringMatching(/no content named "nope" \(this agent has: app\)/),
    ]);
    // With a name of its own it is added.
    const named = await cli(["content", "add", other, agentDir, "--name", "app2"], root);
    expect(named.code, named.stderr).toBe(0);
    expect(named.stderr).toContain(`works on app2  ${other} (a directory of this machine)`);
    expect(JSON.parse(await readFile(join(agentDir, "fastagent.json"), "utf8")).content).toEqual({
      app: { path: app },
      app2: { path: other },
    });
  });
});
