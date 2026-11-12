/**
 * The environment (src/environment/): what the `environment` of context.json may declare, and how the agent's own mise
 * installs it here and how a process that runs the agent enters it. mise itself is a stand-in here, a script at the
 * path the agent's platform package would put it: what is tested is FastAgent's side (which isolation, which
 * arguments, where, in which order, what reaches the process), not mise. What mise itself does is not tested here.
 */
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { aptAdvice, missingAptPackages } from "../src/environment/apt.ts";
import {
  checkPackages,
  ensureMise,
  installPackages,
  MISE_PACKAGE_NAMES,
  prepareEnvironment,
} from "../src/environment/mise.ts";
import { openServing } from "../src/harnesses/pi-durable/serve.ts";
import { loadSourceDefinition } from "../src/harnesses/pi-durable/open.ts";
import { log } from "../src/log.ts";
import { NOT_HOSTED } from "../src/serving-command.ts";
import { runInProcess } from "./cli-run.ts";
import { savedEnv, FASTAGENT, agentDir, fakeMise, fakeNpm } from "./environment-fixtures.ts";

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  vi.restoreAllMocks();
});

/** Every file under `dir`, with its content: to see that nothing changed there. */
async function contents(dir: string): Promise<Record<string, string>> {
  const files = (await readdir(dir, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile());
  return Object.fromEntries(
    await Promise.all(
      files.map(async (file) => {
        const path = join(file.parentPath, file.name);
        return [path.slice(dir.length + 1), await readFile(path, "utf8")] as const;
      }),
    ),
  );
}

describe("environment: apt packages on this machine", () => {
  it("are asked of dpkg on Debian or Ubuntu, and nowhere else", async () => {
    expect(missingAptPackages(["chromium"], false)).toBeUndefined();
    const fakeBin = await realpath(await mkdtemp(join(tmpdir(), "fa-env-dpkg-")));
    // dpkg-query prints the packages it knows and exits 1 for an unknown one.
    await writeFile(
      join(fakeBin, "dpkg-query"),
      `#!/bin/sh\necho "git installed"\necho "fonts-noto deinstall"\necho "dpkg-query: no packages found matching chromium" >&2\nexit 1\n`,
    );
    await chmod(join(fakeBin, "dpkg-query"), 0o755);
    process.env.PATH = `${fakeBin}${delimiter}${process.env.PATH}`;
    expect(missingAptPackages(["git", "fonts-noto", "chromium"], true)).toEqual(["fonts-noto", "chromium"]);
    // A Debian-based image without dpkg cannot tell either: nothing is said, and nothing fails.
    process.env.PATH = await realpath(await mkdtemp(join(tmpdir(), "fa-env-no-dpkg-")));
    expect(missingAptPackages(["chromium"], true)).toBeUndefined();
    expect(aptAdvice(["chromium"])).toBe(
      "the image installs apt packages this machine does not have: chromium — `sudo apt-get install -y chromium`",
    );
  });
});

describe("environment: installed by the agent's own mise", () => {
  it("is given no configuration file, the packages as arguments, and prebuilt runtimes only, in the agent directory", async () => {
    const dir = await agentDir();
    const { bin, calls } = await fakeMise(dir);
    await installPackages(dir, bin, { gh: "2", "npm:prettier": "3" });
    const runs = await calls();
    expect(runs.map((call) => call.args).sort()).toEqual([
      "install gh@2 npm:prettier@3",
      "where gh@2",
      "where npm:prettier@3",
    ]);
    for (const call of runs) {
      expect(call.cwd).toBe(dir);
      expect(call.isolation).toBe("/dev/null/none.toml,/dev/null/none.toml,false");
    }
  });

  it("installs only what has no install here, unless asked for every package", async () => {
    const dir = await agentDir();
    const { bin, calls } = await fakeMise(dir);
    vi.spyOn(log, "info").mockImplementation(() => {});
    await installPackages(dir, bin, { gh: "2" });
    await installPackages(dir, bin, { gh: "2", jq: "1" });
    await installPackages(dir, bin, { gh: "2" });
    const installs = (await calls()).filter((call) => call.args.startsWith("install"));
    expect(installs.map((call) => call.args)).toEqual(["install gh@2", "install jq@1"]);
    // What is installed goes on the install's PATH, as a PyPI package needs its uv there; never as a package, which
    // would install a newer release of it.
    expect((await calls()).map((call) => call.args)).toContain("env --json gh@2");
    expect(installs.map((call) => call.path)).toEqual([process.env.PATH?.split(delimiter)[0], "/fake/tools"]);
    // `all` asks mise for each again: a newer release where one is out.
    await installPackages(dir, bin, { gh: "2", jq: "1" }, "all");
    expect((await calls()).at(-1)?.args).toBe("install gh@2 jq@1");
    // So does naming them, as `env add` does with what it adds: an install that matches may be another project's,
    // older than the newest the version allows. What is installed and not named goes on the PATH.
    await installPackages(dir, bin, { gh: "2", jq: "1" }, ["jq"]);
    expect((await calls()).slice(-3).map((call) => call.args)).toEqual([
      "where gh@2",
      "env --json gh@2",
      "install jq@1",
    ]);
    process.env.FAKE_FAIL_INSTALL = "1";
    await expect(installPackages(dir, bin, { jq: "99" })).rejects.toThrow(
      "mise install jq@99 failed (exit 1): no version of jq matches 99",
    );
  });

  it("passes mise's progress on, without the `mise use` it suggests; a failure carries every line of the reason", async () => {
    const dir = await agentDir();
    const { bin } = await fakeMise(dir);
    vi.spyOn(log, "info").mockImplementation(() => {});
    const written: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    await installPackages(dir, bin, { gh: "2" });
    expect(written.join("")).toBe("mise gh@2 ✓ installed\n");
    process.env.FAKE_FAIL_INSTALL = "many";
    await expect(installPackages(dir, bin, { jq: "99", yq: "0" })).rejects.toThrow(
      "mise install jq@99 yq@0 failed (exit 1): Failed to install tools: jq@99 yq@0; " +
        "GET https://example.com/jq: 404 Not Found",
    );
  });

  it("checks each package by its backend: a written one says it, mise resolves a registry name", async () => {
    const dir = await agentDir();
    const { bin, calls } = await fakeMise(dir);
    const check = await checkPackages(dir, bin, { tokei: "12", ansible: "11", "pypi:markitdown": "1", gh: "2" });
    expect(check.refusals).toEqual([expect.stringMatching(/^package "tokei" resolves to cargo:tokei, which builds/)]);
    expect(check.runtime).toEqual({ packages: ["ansible", "pypi:markitdown"], missing: ["python", "uv"] });
    expect((await calls()).map((call) => call.args).sort()).toEqual([
      "tool ansible --json",
      "tool gh --json",
      "tool tokei --json",
    ]);
    await expect(checkPackages(dir, bin, { nope: "1" })).rejects.toThrow(
      "mise tool nope --json failed (exit 1): nope not found in mise tool registry",
    );
  });
});

describe("environment: prepared by a process that runs the agent", () => {
  it("installs what is missing and answers the PATH that puts the packages first, writing nothing", async () => {
    const dir = await agentDir({ packages: { gh: "2", jq: "1" } });
    const { calls } = await fakeMise(dir);
    vi.spyOn(log, "info").mockImplementation(() => {});
    const before = await contents(dir);
    const variables = await prepareEnvironment(dir, process.env);
    // `where` asks of each package at once, so those runs are in no particular order.
    const args = (await calls()).map((call) => call.args);
    expect([...args.slice(0, 2).sort(), ...args.slice(2)]).toEqual([
      "where gh@2",
      "where jq@1",
      "install gh@2 jq@1",
      "env --json gh@2 jq@1",
    ]);
    expect(await contents(dir)).toEqual(before);
    expect((variables.PATH ?? "").split(delimiter)[0]).toBe("/fake/tools");
    expect(variables.FAKE_TOOL_HOME).toBe("/fake/home");
    // Answered, not entered: this process may run other agents.
    expect(process.env).toEqual(savedEnv);
    // The isolation is these runs' alone, and the agent's mise is not on the PATH.
    for (const name of ["MISE_OVERRIDE_CONFIG_FILENAMES", "MISE_GLOBAL_CONFIG_FILE", "MISE_PYTHON_COMPILE"]) {
      expect(variables[name], name).toBeUndefined();
    }
    expect(variables.PATH).not.toContain(join(dir, "node_modules"));
    // The next start has them all: it installs nothing, so it needs no network.
    await prepareEnvironment(dir, process.env);
    const again = (await calls()).slice(4).map((call) => call.args);
    expect([...again.slice(0, 2).sort(), ...again.slice(2)]).toEqual([
      "where gh@2",
      "where jq@1",
      "env --json gh@2 jq@1",
    ]);
  });

  it("is prepared as the agent opens, in the agent's own environment, leaving this process's as it was", async () => {
    await expect(
      openServing(await loadSourceDefinition(await agentDir({ packages: { gh: "2" } })), {
        secrets: {},
        env: {},
        ownEnv: process.env,
        runsAs: NOT_HOSTED,
        storage: "memory",
      }),
    ).rejects.toThrow(/the agent has no mise installed/);
    const dir = await agentDir({ packages: { gh: "2" } });
    const { calls } = await fakeMise(dir);
    vi.spyOn(log, "info").mockImplementation(() => {});
    const secrets = { FAKE_AGENT_VALUE: "from-the-value-file" };
    await (
      await openServing(await loadSourceDefinition(dir), {
        secrets,
        env: {},
        ownEnv: process.env,
        runsAs: NOT_HOSTED,
        storage: "memory",
      })
    ).agent.close();
    // mise reached GitHub, say, with the agent's own token.
    expect((await calls()).map((call) => `${call.args.split(" ")[0]}: ${call.agentValue}`)).toEqual([
      "where: from-the-value-file",
      "install: from-the-value-file",
      "env: from-the-value-file",
    ]);
    expect(process.env).toEqual(savedEnv);
  });
});

describe("environment: the agent's own mise", () => {
  it("is added to the agent's package.json, every platform pinned, by the command that changes the environment", async () => {
    const dir = await agentDir();
    const pkg = join(dir, "node_modules", "@jdxcode", `mise-${process.platform}-${process.arch}`);
    const fakeBin = await fakeNpm(dir);
    process.env.PATH = `${fakeBin}${delimiter}${process.env.PATH}`;
    vi.spyOn(log, "info").mockImplementation(() => {});
    expect(await ensureMise(dir)).toBe(join(pkg, "bin", "mise"));
    expect((await readFile(join(dir, "npm-args"), "utf8")).trim()).toBe(
      "install --save-optional --save-exact --no-audit --no-fund @jdxcode/mise-darwin-arm64@latest " +
        "@jdxcode/mise-darwin-x64@latest @jdxcode/mise-linux-arm64@latest @jdxcode/mise-linux-x64@latest",
    );
  });

  it("a clone that lists mise and has not installed its dependencies keeps the version it pins", async () => {
    const dir = await agentDir();
    const optionalDependencies = Object.fromEntries(MISE_PACKAGE_NAMES.map((name) => [name, "2026.10.7"]));
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "a", private: true, dependencies: FASTAGENT, optionalDependencies }),
    );
    const fakeBin = await fakeNpm(dir);
    process.env.PATH = `${fakeBin}${delimiter}${process.env.PATH}`;
    vi.spyOn(log, "info").mockImplementation(() => {});
    await ensureMise(dir);
    expect((await readFile(join(dir, "npm-args"), "utf8")).trim()).toBe("install --no-audit --no-fund");
  });
});

describe("environment: `fastagent env`", () => {
  const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const cli = (args: string[], cwd: string, env: Record<string, string> = {}) =>
    runInProcess(args, cwd, { ...process.env, ...env });
  /** The CLI as a process: for what only one shows (a command's own stdio, an interrupt, two at once). */
  const spawnCli = (
    args: string[],
    cwd: string,
    env: Record<string, string> = {},
  ): Promise<{ code: number | null; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, ...env } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  const declared = async (dir: string): Promise<unknown> =>
    JSON.parse(await readFile(join(dir, "context.json"), "utf8")).environment;

  it("adds packages: installed first, declared last; an apt package is declared without mise", async () => {
    const dir = await agentDir();
    await writeFile(join(dir, "context.json"), `{"content":{}}`);
    const { calls, log } = await fakeMise(dir);
    const add = await cli(["env", "add", "gh@2", "npm:prettier@3"], dir);
    expect(add.code, add.stderr).toBe(0);
    expect(await declared(dir)).toEqual({ packages: { gh: "2", "npm:prettier": "3" } });
    // At install time the declaration was not written yet.
    expect(await log()).toContain(`context.json at install: {"content":{}}`);
    expect((await calls()).map((call) => call.args).filter((args) => args.startsWith("install"))).toEqual([
      "install gh@2 npm:prettier@3",
    ]);
    const before = (await calls()).length;
    const apt = await cli(["env", "add", "apt:chromium"], dir);
    expect(apt.code, apt.stderr).toBe(0);
    expect(await declared(dir)).toEqual({ packages: { gh: "2", "npm:prettier": "3" }, aptPackages: ["chromium"] });
    expect((await calls()).length).toBe(before);
    // What it adds, or declares at another version, is installed at the newest release, whatever matches here.
    expect((await cli(["env", "add", "gh@2", "jq@1"], dir)).code).toBe(0);
    expect((await calls()).at(-1)?.args).toBe("install jq@1");
    expect((await cli(["env", "add", "jq@1", "gh@latest"], dir)).code).toBe(0);
    expect((await calls()).at(-1)?.args).toBe("install gh@latest");
  });

  it("keeps the variables when it changes the packages", async () => {
    const variables = { FA_TEST_HOST: { description: "the GitHub host gh talks to" } };
    const dir = await agentDir({ variables });
    await fakeMise(dir);
    expect((await cli(["env", "add", "gh@2", "apt:chromium"], dir)).code).toBe(0);
    expect((await cli(["env", "remove", "apt:chromium"], dir)).code).toBe(0);
    expect(await declared(dir)).toEqual({ packages: { gh: "2" }, variables });
  });

  it("refuses a package FastAgent does not install from, and one mise cannot install, changing nothing", async () => {
    const dir = await agentDir({ packages: { gh: "2" } });
    await fakeMise(dir);
    const tokei = await cli(["env", "add", "tokei"], dir);
    expect(tokei.code).toBe(1);
    expect(tokei.stderr).toMatch(/package "tokei" resolves to cargo:tokei, which builds from source/);
    const vfox = await cli(["env", "add", "vfox:jdx/vfox-php"], dir);
    expect(vfox.code).toBe(1);
    expect(vfox.stderr).toMatch(/installs with vfox:, which runs a plugin's code/);
    const failing = await cli(["env", "add", "jq@99"], dir, { FAKE_FAIL_INSTALL: "1" });
    expect(failing.code).toBe(1);
    // What is declared and not installed here is installed with it: gh as well.
    expect(failing.stderr).toContain("mise install gh@2 jq@99 failed (exit 1): no version of jq matches 99");
    expect(await declared(dir)).toEqual({ packages: { gh: "2" } });
  });

  it("leaves context.json as it was when interrupted mid-install", async () => {
    const dir = await agentDir({ aptPackages: ["chromium"] });
    const { log } = await fakeMise(dir);
    const child = spawn(process.execPath, [CLI, "env", "add", "gh@2"], {
      cwd: dir,
      env: { ...process.env, FAKE_SLOW: "1" },
    });
    const exited = new Promise((resolve) => child.on("close", resolve));
    while (!(await log()).includes("context.json at install")) await new Promise((r) => setTimeout(r, 50));
    child.kill("SIGINT");
    await exited;
    expect(await declared(dir)).toEqual({ aptPackages: ["chromium"] });
  }, 30_000);

  it("install installs every declared package at the newest release it allows, asking mise each time", async () => {
    const dir = await agentDir({ packages: { gh: "2", jq: "1" }, aptPackages: ["chromium"] });
    const { calls } = await fakeMise(dir);
    for (let run = 0; run < 2; run++) {
      const install = await cli(["env", "install"], dir);
      expect(install.code, install.stderr).toBe(0);
      // Nothing it writes restarts `dev`, so it says what a running one keeps.
      expect(install.stderr).toContain(
        "a running `fastagent dev` keeps the releases it started with until it restarts",
      );
    }
    // The packages are checked in parallel, so their `tool` runs are in no particular order.
    const args = (await calls()).map((call) => call.args);
    expect(args.slice(0, 2).sort()).toEqual(["tool gh --json", "tool jq --json"]);
    expect(args.filter((call) => call.startsWith("install"))).toEqual(["install gh@2 jq@1", "install gh@2 jq@1"]);
  });

  it("lists the packages with their versions, and what is wrong with them", async () => {
    const dir = await agentDir({
      packages: { gh: "2", tokei: "12", "pypi:markitdown": "1" },
      aptPackages: ["chromium"],
    });
    await fakeMise(dir);
    const list = await cli(["env", "list"], dir);
    expect(list.code, list.stderr).toBe(0);
    expect(list.stdout).toBe(
      [
        "gh               2",
        "tokei            12",
        "pypi:markitdown  1",
        "apt:chromium     (installed by the image)",
        "",
      ].join("\n"),
    );
    expect(list.stderr).toMatch(/package "tokei" resolves to cargo:tokei/);
    expect(list.stderr).toMatch(/pypi:markitdown installs with python and uv/);
  });

  it("runs a command in the environment, and exits as it does", async () => {
    const dir = await agentDir({ packages: { gh: "2" } });
    await fakeMise(dir);
    const exec = await spawnCli(["env", "exec", "--", "sh", "-c", 'echo "$PATH"; exit 3'], dir);
    expect(exec.code).toBe(3);
    expect(exec.stdout.split(delimiter)[0]).toBe("/fake/tools");
    // The command's arguments are its own, an empty one included.
    const empty = await spawnCli(["env", "exec", "--", "sh", "-c", 'printf "[%s]" "$1"', "sh", ""], dir);
    expect(empty.code, empty.stderr).toBe(0);
    expect(empty.stdout).toBe("[]");
    const missing = await spawnCli(["env", "exec", "--", "no-such-command-here"], dir);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("no-such-command-here: command not found in the environment");
  });

  it("two edits at once keep both: each is written to context.json as it is by then", async () => {
    const dir = await agentDir();
    const { log } = await fakeMise(dir);
    const first = spawnCli(["env", "add", "gh@2"], dir, { FAKE_SLOW: "1" });
    while (!(await log()).includes("context.json at install")) await new Promise((r) => setTimeout(r, 50));
    const second = await spawnCli(["env", "add", "jq@1"], dir);
    expect(second.code, second.stderr).toBe(0);
    expect((await first).code).toBe(0);
    expect(await declared(dir)).toEqual({ packages: { gh: "2", jq: "1" } });
  }, 30_000);
});
