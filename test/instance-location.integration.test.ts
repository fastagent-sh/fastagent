/**
 * Where an instance is, as a command's flags and the environment place it (agent-artifact.md §4.1): the resolvers'
 * precedence, and that each command that opens or reads an instance follows them. The merge of what the configuration
 * says is config.test.ts's.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentWorkspace, built, runInProcess, whileRunning } from "./cli-run.ts";

const scratch = () => mkdtemp(join(tmpdir(), "fa-instance-"));

describe("commands that open an instance", () => {
  it("start serves the built project from the root, with the state and the configuration it names", async () => {
    const dir = await agentWorkspace("fa-instance-start-", {
      "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini" } };\n`,
      ".secrets/production/.env": "OPENAI_API_KEY=sk-test\n",
    });
    await built(dir);
    const root = await scratch();
    const state = await scratch();
    const config = join(await scratch(), "fastagent.json");
    await writeFile(config, JSON.stringify({ http: { api: false } }));
    await whileRunning(
      [
        "start",
        dir,
        "--port",
        "0",
        "--bind",
        "127.0.0.1",
        "--no-input",
        "--root",
        root,
        "--state",
        state,
        "--config",
        config,
      ],
      /Agent API: .*\n/,
      async (stderr) => {
        expect(stderr).toContain(` — ${root}\n`);
        expect(stderr).toContain(`state:       ${state}`);
        expect(stderr).toContain("Agent API: not served — the configuration says http.api: false");
      },
    );
    expect(existsSync(join(state, "agent.sqlite"))).toBe(true);
    expect(existsSync(join(dir, ".state"))).toBe(false);
  });

  it("start names the project's value file, not the root's, where credentials are looked for", async () => {
    const dir = await agentWorkspace("fa-instance-hint-", {
      "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini" } };\n`,
    });
    await built(dir);
    const root = await scratch();
    const env = { ...process.env };
    delete env.OPENAI_API_KEY;
    await whileRunning(
      ["start", dir, "--port", "0", "--bind", "127.0.0.1", "--no-input", "--root", root],
      /Agent API: .*\n/,
      async (stderr) => {
        expect(stderr).toContain(`in ${join(dir, ".secrets", "production", ".env")}`);
        expect(stderr).not.toContain(join(root, ".secrets"));
      },
      env,
    );
  });

  it("with no flags, start runs from .fastagent/start/, apart from dev's .fastagent/dev/", async () => {
    const dir = await agentWorkspace("fa-instance-default-start-", {
      "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini" } };\n`,
      ".secrets/production/.env": "OPENAI_API_KEY=sk-test\n",
    });
    await built(dir);
    await whileRunning(
      ["start", dir, "--port", "0", "--bind", "127.0.0.1", "--no-input"],
      /Agent API: .*\n/,
      async (stderr) => {
        expect(stderr).toContain(` — ${join(dir, ".fastagent", "start")}\n`);
        expect(stderr).toContain(`state:       ${join(dir, ".fastagent", "start", ".state")}`);
      },
    );
    expect(existsSync(join(dir, ".fastagent", "start", ".state", "agent.sqlite"))).toBe(true);
    expect(existsSync(join(dir, ".fastagent", "dev"))).toBe(false);
  });

  it("start does not read the project's fastagent.json: only the configuration it is given", async () => {
    const dir = await agentWorkspace("fa-instance-start-own-", {
      "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini" } };\n`,
      "fastagent.json": JSON.stringify({ http: { api: false } }),
      ".secrets/production/.env": "OPENAI_API_KEY=sk-test\nFASTAGENT_API_KEY=k\n",
    });
    await built(dir);
    await whileRunning(
      ["start", dir, "--port", "0", "--bind", "127.0.0.1", "--no-input"],
      /Agent API: .*\n/,
      async (stderr) => expect(stderr).not.toContain("not served"),
    );
  });
});

describe("content commands", () => {
  const added = async (dir: string, args: string[], env?: NodeJS.ProcessEnv) => {
    const result = await runInProcess(["content", "add", ...args, dir], undefined, env);
    expect(result.code, result.stderr).toBe(0);
    return result;
  };

  it("edit the project's fastagent.json by default, the one --config or FASTAGENT_CONFIG names instead, context.json with --program", async () => {
    const dir = await agentWorkspace("fa-content-config-");
    const notes = join(await scratch(), "notes");
    await mkdir(notes);
    await added(dir, [notes]);
    expect(JSON.parse(await readFile(join(dir, "fastagent.json"), "utf8"))).toEqual({
      content: { notes: { path: notes } },
    });

    const other = join(await scratch(), "other.json");
    await added(dir, [notes, "--name", "more", "--config", other]);
    expect(JSON.parse(await readFile(other, "utf8"))).toEqual({ content: { more: { path: notes } } });
    const viaVariable = join(await scratch(), "variable.json");
    await added(dir, [notes, "--name", "again"], { ...process.env, FASTAGENT_CONFIG: viaVariable });
    expect(Object.keys(JSON.parse(await readFile(viaVariable, "utf8")).content)).toEqual(["again"]);
    expect(Object.keys(JSON.parse(await readFile(join(dir, "fastagent.json"), "utf8")).content)).toEqual(["notes"]);

    await added(dir, ["github:acme/docs", "--program"]);
    expect(JSON.parse(await readFile(join(dir, "context.json"), "utf8")).content).toEqual({
      docs: { github: "acme/docs" },
    });
    const refused = await runInProcess(["content", "add", notes, dir, "--name", "dir", "--program"]);
    expect([refused.code, refused.stderr]).toEqual([1, expect.stringContaining("context.json is shared")]);
  });

  it("a directory inside the instance root is content like any other, not nested in the agent", async () => {
    const dir = await agentWorkspace("fa-content-inroot-");
    const root = await scratch();
    await mkdir(join(root, "data"));
    const config = join(await scratch(), "fastagent.json");
    await writeFile(config, JSON.stringify({ content: { data: { path: join(root, "data") } } }));
    const listed = await runInProcess(["content", "list", dir, "--json", "--root", root, "--config", config]);
    expect(listed.code, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout).content).toEqual([expect.objectContaining({ name: "data" })]);
    const added = await runInProcess([
      "content",
      "add",
      root,
      dir,
      "--name",
      "all",
      "--root",
      root,
      "--config",
      config,
    ]);
    expect(added.code, added.stderr).toBe(0);
  });
});
