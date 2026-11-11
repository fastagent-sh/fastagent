/**
 * Where an instance is, as a command's flags and the environment place it (agent-artifact.md §4.1): the resolvers'
 * precedence, and that each command that opens or reads an instance follows them. The merge of what the configuration
 * says is config.test.ts's.
 */
import { existsSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveStateRoot, resolveWorkdir } from "../src/paths.ts";
import { addWakeup } from "../src/schedule/wakeups.ts";
import { agentWorkspace, built, fauxAgent, runInProcess, whileRunning } from "./cli-run.ts";

const scratch = () => mkdtemp(join(tmpdir(), "fa-instance-"));

describe("the resolvers", () => {
  const dir = "/project";

  it("state: the state directory, else .state in the root, else in the project's default root for the environment", () => {
    expect(resolveStateRoot(dir, {})).toBe("/project/.fastagent/dev/.state");
    expect(resolveStateRoot(dir, { FASTAGENT_ENVIRONMENT: "dev" })).toBe("/project/.fastagent/dev/.state");
    expect(resolveStateRoot(dir, { FASTAGENT_ENVIRONMENT: "production" })).toBe("/project/.fastagent/start/.state");
    expect(resolveStateRoot(dir, { FASTAGENT_ROOT: "/r" })).toBe("/r/.state");
    expect(resolveStateRoot(dir, { FASTAGENT_ROOT: "/r", FASTAGENT_STATE_DIR: "/s" })).toBe("/s");
    expect(resolveStateRoot(dir, { FASTAGENT_STATE_DIR: "/s" })).toBe("/s");
  });

  it("working directory: the workspace directory, else the root, else the project's default root for the environment", () => {
    expect(resolveWorkdir(dir, {})).toBe("/project/.fastagent/dev");
    expect(resolveWorkdir(dir, { FASTAGENT_ENVIRONMENT: "production" })).toBe("/project/.fastagent/start");
    expect(resolveWorkdir(dir, { FASTAGENT_ROOT: "/r" })).toBe("/r");
    expect(resolveWorkdir(dir, { FASTAGENT_ROOT: "/r", FASTAGENT_WORKDIR: "/w" })).toBe("/w");
    expect(resolveWorkdir(dir, { FASTAGENT_WORKDIR: "/w" })).toBe("/w");
  });
});

describe("info reports where the instance is", () => {
  const where = async (args: string[], cwd?: string, env: NodeJS.ProcessEnv = process.env) => {
    const dir = await agentWorkspace("fa-instance-info-");
    const result = await runInProcess(["info", dir, "--json", ...args], cwd, env);
    expect(result.code, result.stderr).toBe(0);
    const { workdir, stateRoot } = JSON.parse(result.stdout) as { workdir: string; stateRoot: string };
    return { dir, workdir, stateRoot };
  };

  it("a root places the working directory and, in it, the state", async () => {
    const root = join(await scratch(), "root");
    const found = await where(["--root", root]);
    expect([found.workdir, found.stateRoot]).toEqual([root, join(root, ".state")]);
    expect(existsSync(root)).toBe(true); // made, as an instance's root is
  });

  it("the state and the workdir move apart from the root and from each other", async () => {
    const root = await scratch();
    const state = await scratch();
    const workdir = await scratch();
    const found = await where(["--root", root, "--state", state, "--workdir", workdir]);
    expect([found.workdir, found.stateRoot]).toEqual([workdir, state]);
  });

  it("with no flag: the project's .fastagent/dev/ is the working directory and holds the state", async () => {
    const found = await where([]);
    const root = join(found.dir, ".fastagent", "dev");
    expect([found.workdir, found.stateRoot]).toEqual([root, join(root, ".state")]);
    // Said, not made: `info` reads, and the open makes it.
    expect(existsSync(root)).toBe(false);
  });

  it("a flag beats its environment variable, which beats the default", async () => {
    const fromEnv = await scratch();
    const fromFlag = await scratch();
    const env = { ...process.env, FASTAGENT_ROOT: fromEnv };
    expect((await where([], undefined, env)).workdir).toBe(fromEnv);
    expect((await where(["--root", fromFlag], undefined, env)).workdir).toBe(fromFlag);
  });

  it("a relative path is resolved once, against the directory the command started in", async () => {
    const start = await scratch();
    const found = await where(["--root", "inst"], start);
    expect(found.workdir).toBe(join(realpathSync(start), "inst"));
  });

  it("a root that cannot be a directory refuses in one line, naming the flag and the path", async () => {
    const dir = await agentWorkspace("fa-instance-notdir-");
    const file = join(await scratch(), "afile");
    await writeFile(file, "");
    for (const path of [file, join(file, "sub")]) {
      const result = await runInProcess(["info", dir, "--root", path]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(`--root ${path} cannot be used as a directory`);
      expect(result.stderr).not.toContain("at mkdirSync");
    }
    const viaVariable = await runInProcess(["info", dir], undefined, { ...process.env, FASTAGENT_WORKDIR: file });
    expect(viaVariable.stderr).toContain(`FASTAGENT_WORKDIR ${file} cannot be used as a directory`);
  });

  it("a flag with no path is a usage error", async () => {
    const dir = await agentWorkspace("fa-instance-empty-");
    const result = await runInProcess(["info", dir, "--root", ""]);
    expect([result.code, result.stderr]).toEqual([2, expect.stringContaining("--root needs a path")]);
  });
});

describe("commands that open an instance", () => {
  it("invoke runs in the root and keeps its state there, leaving the project's own untouched", async () => {
    const dir = await fauxAgent("fa-instance-invoke-");
    const root = join(await scratch(), "root");
    const result = await runInProcess(["invoke", "hello", dir, "--root", root]);
    expect([result.code, result.stdout.trim()], result.stderr).toEqual([0, "seen 1"]);
    expect(existsSync(join(root, ".state", "invoke.sqlite"))).toBe(true);
    expect(existsSync(join(dir, ".state"))).toBe(false);
  });

  it("invoke's tools run in the working directory it is given, not the project", async () => {
    const dir = await fauxAgent("fa-instance-workdir-");
    const workdir = await scratch();
    await writeFile(join(workdir, "SYSTEM.md"), "READ-FROM-THE-WORKDIR\n");
    const result = await runInProcess(["invoke", "use a tool", dir, "--workdir", workdir, "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("READ-FROM-THE-WORKDIR");
  });

  it("with no flags, invoke keeps its state and works in the project's .fastagent/dev/, leaving the project alone", async () => {
    const dir = await fauxAgent("fa-instance-default-invoke-");
    const result = await runInProcess(["invoke", "hello", dir]);
    expect([result.code, result.stdout.trim()], result.stderr).toEqual([0, "seen 1"]);
    expect(existsSync(join(dir, ".fastagent", "dev", ".state", "invoke.sqlite"))).toBe(true);
    expect(existsSync(join(dir, ".state"))).toBe(false);
    expect(existsSync(join(dir, ".fastagent", "start"))).toBe(false);
  });

  it("makes the default working directory even when the state is elsewhere", async () => {
    const dir = await fauxAgent("fa-instance-default-apart-");
    const state = join(await scratch(), "state");
    const result = await runInProcess(["invoke", "hello", dir, "--state", state]);
    expect(result.code, result.stderr).toBe(0);
    expect(existsSync(join(dir, ".fastagent", "dev"))).toBe(true);
    expect(existsSync(join(state, "invoke.sqlite"))).toBe(true);
  });

  it("with no flags, the agent's own commands start in that working directory, not the project", async () => {
    const dir = await fauxAgent("fa-instance-default-cwd-");
    const result = await runInProcess(["invoke", "use a tool", dir, "--json"]);
    expect(result.code, result.stderr).toBe(0);
    // The faux model's tool reads SYSTEM.md relative to the working directory: the project's is not there.
    expect(result.stdout).toContain("tool_started");
    expect(result.stdout).not.toContain("You are terse.");
  });

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

  it("schedules list and unwake read the state they are pointed at", async () => {
    const dir = await agentWorkspace("fa-instance-schedules-");
    const state = await scratch();
    const added = addWakeup(state, { session: "chat:1", prompt: "check", fireAt: new Date(Date.now() + 3_600_000) });
    if (!added.ok) throw new Error(added.error);
    const listed = await runInProcess(["schedules", "list", dir, "--state", state]);
    expect(listed.stdout).toContain(`wake ${added.id}`);
    expect((await runInProcess(["schedules", "list", dir])).stdout).not.toContain("wake ");
    const removed = await runInProcess(["schedules", "unwake", added.id, dir, "--state", state]);
    expect([removed.code, removed.stdout], removed.stderr).toEqual([0, expect.stringContaining(`removed wake`)]);
  });
});

describe("the configuration a command is given", () => {
  it("--config names the instance configuration, over the project's own, and a missing file refuses", async () => {
    const dir = await agentWorkspace("fa-instance-config-", {
      "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini" } };\n`,
      "fastagent.json": JSON.stringify({ thinkingLevel: "low" }),
    });
    const named = join(await scratch(), "other.json");
    await writeFile(named, JSON.stringify({ thinkingLevel: "high" }));
    const project = await runInProcess(["info", dir, "--json"]);
    expect(JSON.parse(project.stdout).thinkingLevel).toBe("low");
    const over = await runInProcess(["info", dir, "--json", "--config", named]);
    expect(JSON.parse(over.stdout).config.thinkingLevel).toEqual({ value: "high", source: named });
    const missing = await runInProcess(["info", dir, "--json", "--config", join(dirname(named), "absent.json")]);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain("absent.json");
  });

  it("FASTAGENT_CONFIG is the same input as --config", async () => {
    const dir = await agentWorkspace("fa-instance-config-env-", {
      "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini" } };\n`,
    });
    const named = join(await scratch(), "env.json");
    await writeFile(named, JSON.stringify({ thinkingLevel: "high" }));
    const found = await runInProcess(["info", dir, "--json"], undefined, { ...process.env, FASTAGENT_CONFIG: named });
    expect(JSON.parse(found.stdout).thinkingLevel).toBe("high");
  });

  it("FASTAGENT_CONFIG_JSON is the configuration itself, for a box that has no file for it", async () => {
    const dir = await agentWorkspace("fa-instance-config-json-", {
      "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini" } };\n`,
    });
    const env = (extra: Record<string, string>) => ({ ...process.env, ...extra });
    const found = await runInProcess(
      ["info", dir, "--json"],
      undefined,
      env({ FASTAGENT_CONFIG_JSON: '{"thinkingLevel":"high"}' }),
    );
    expect(JSON.parse(found.stdout).config.thinkingLevel).toEqual({ value: "high", source: "FASTAGENT_CONFIG_JSON" });

    // Both would be a guess about which one counted.
    const named = join(await scratch(), "env.json");
    await writeFile(named, JSON.stringify({ thinkingLevel: "low" }));
    const both = await runInProcess(
      ["info", dir, "--json"],
      undefined,
      env({ FASTAGENT_CONFIG: named, FASTAGENT_CONFIG_JSON: "{}" }),
    );
    expect(both.code).not.toBe(0);
    expect(both.stderr).toContain("FASTAGENT_CONFIG and FASTAGENT_CONFIG_JSON are both set");

    const broken = await runInProcess(["info", dir, "--json"], undefined, env({ FASTAGENT_CONFIG_JSON: "{nope" }));
    expect(broken.code).not.toBe(0);
    expect(broken.stderr).toContain("FASTAGENT_CONFIG_JSON is not JSON");
  });
});

describe("--env-file: the file an agent's secrets are read from", () => {
  const needing = {
    "src/tools/hello.ts": `import { needs } from "@fastagent-sh/fastagent";
export default needs([{ name: "FA_ENVFILE_KEY" }], () => ({ name: "hello", description: "d", parameters: { type: "object", properties: {} }, execute: async () => ({ output: [] }) }));
`,
  };

  it("replaces the default value file: info finds the secret there and nowhere else", async () => {
    const dir = await agentWorkspace("fa-envfile-info-", {
      ...needing,
      ".secrets/.env": "FA_ENVFILE_KEY=from-the-default\n",
    });
    const other = join(await scratch(), "other.env");
    await writeFile(other, "SOMETHING_ELSE=1\n");
    const unset = async (args: string[]) => {
      const result = await runInProcess(["info", dir, "--json", ...args]);
      expect(result.code, result.stderr).toBe(0);
      return (JSON.parse(result.stdout) as { unsetSecrets: string[] }).unsetSecrets;
    };
    expect(await unset([])).toEqual([]);
    expect(await unset(["--env-file", other])).toEqual(["FA_ENVFILE_KEY"]);
    const named = join(await scratch(), "named.env");
    await writeFile(named, "FA_ENVFILE_KEY=from-the-named\n");
    expect(await unset(["--env-file", named])).toEqual([]);
  });

  it("refuses a file that is not there, naming it, rather than starting with no secrets", async () => {
    const dir = await agentWorkspace("fa-envfile-missing-");
    const absent = join(await scratch(), "absent.env");
    const result = await runInProcess(["info", dir, "--env-file", absent]);
    expect([result.code, result.stderr]).toEqual([2, expect.stringContaining(`--env-file ${absent} is not a file`)]);
    expect((await runInProcess(["info", dir, "--env-file", ""])).stderr).toContain("--env-file needs a path");
  });

  it("is that command's alone: a stray FASTAGENT_ENV_FILE in the shell changes nothing, and the next command is back on the default", async () => {
    const dir = await agentWorkspace("fa-envfile-own-", {
      ".secrets/.env": "FA_ENVFILE_KEY=from-the-default\n",
      ...needing,
    });
    const elsewhere = join(await scratch(), "else.env");
    await writeFile(elsewhere, "SOMETHING_ELSE=1\n");
    const unset = async (args: string[], env?: NodeJS.ProcessEnv) => {
      const result = await runInProcess(["info", dir, "--json", ...args], undefined, env);
      return (JSON.parse(result.stdout) as { unsetSecrets: string[] }).unsetSecrets;
    };
    expect(await unset(["--env-file", elsewhere])).toEqual(["FA_ENVFILE_KEY"]);
    expect(await unset([])).toEqual([]);
    expect(await unset([], { ...process.env, FASTAGENT_ENV_FILE: elsewhere })).toEqual([]);
  });

  it("invoke reads the secrets its model needs from it", async () => {
    const dir = await fauxAgent("fa-envfile-invoke-", needing);
    const refused = await runInProcess(["invoke", "hello", dir]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("missing required secrets: FA_ENVFILE_KEY (src/tools/hello.ts)");
    const file = join(await scratch(), "values.env");
    await writeFile(file, "FA_ENVFILE_KEY=k\n");
    const answered = await runInProcess(["invoke", "hello", dir, "--env-file", file]);
    expect([answered.code, answered.stdout.trim()], answered.stderr).toEqual([0, "seen 1"]);
  });
});

describe("invoke --url", () => {
  const serverSeeing = async (during: (url: string) => Promise<void>) => {
    const seen: (string | undefined)[] = [];
    const server = createServer((req, res) => {
      seen.push(req.headers.authorization);
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("refused");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      await during(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    return seen;
  };

  it("calls with the key of the --env-file it is given, over the project's production one", async () => {
    const dir = await agentWorkspace("fa-envfile-url-", {
      ".secrets/production/.env": "FASTAGENT_API_KEY=from-default\n",
    });
    const file = join(await scratch(), "key.env");
    await writeFile(file, "FASTAGENT_API_KEY=from-the-file\n");
    const seen = await serverSeeing(async (url) => {
      await runInProcess(["invoke", "hi", dir, "--url", url, "--env-file", file]);
    });
    expect(seen[0]).toBe("Bearer from-the-file");
  });

  it("refuses a flag that places an instance, since it opens none", async () => {
    const dir = await agentWorkspace("fa-envfile-url-root-");
    const result = await runInProcess([
      "invoke",
      "hi",
      dir,
      "--url",
      "http://127.0.0.1:9",
      "--key",
      "k",
      "--root",
      "/x",
    ]);
    expect([result.code, result.stderr]).toEqual([2, expect.stringContaining("--root places an instance")]);
  });
});

describe("what a command opens an instance with", () => {
  it("the process environment as its secrets, and only the base list of it as the agent's processes' base", async () => {
    const { instanceInputs } = await import("../src/cli/instance.ts");
    const dir = await scratch();
    const saved = { ...process.env };
    process.env.FA_STRAY = "stray";
    process.env.PATH = saved.PATH ?? "/usr/bin";
    try {
      const inputs = instanceInputs(dir);
      expect(inputs.secrets).toMatchObject({ FA_STRAY: "stray" });
      expect(inputs.env).toMatchObject({ PATH: process.env.PATH });
      expect(inputs.env).not.toHaveProperty("FA_STRAY");
    } finally {
      delete process.env.FA_STRAY;
    }
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

  it("list resolves a clone in the working directory it is given", async () => {
    const dir = await agentWorkspace("fa-content-workdir-", {
      "context.json": JSON.stringify({ content: { docs: { github: "acme/docs" } } }),
    });
    const workdir = join(await scratch(), "work");
    const listed = await runInProcess(["content", "list", dir, "--json", "--workdir", workdir]);
    expect(listed.code, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout).content).toEqual([
      expect.objectContaining({ name: "docs", location: join(workdir, "content", "docs") }),
    ]);
  });
});
