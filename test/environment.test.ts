/**
 * The environment (src/environment/): what an agent's mise.toml may declare, and how FastAgent runs the agent's own
 * mise on it. mise itself is a stand-in here, a script at the path the agent's platform package would put it: what is
 * tested is FastAgent's side (which file, which isolation, which arguments, what reaches the process), not mise.
 */
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readEnvironment } from "../src/environment/declare.ts";
import {
  enterEnvironment,
  ensureMise,
  lockEnvironment,
  MISE_PACKAGE_NAMES,
  miseBinary,
} from "../src/environment/mise.ts";
import { log } from "../src/log.ts";

const savedEnv = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

async function agentDir(miseToml?: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "fa-env-")));
  await writeFile(join(dir, "fastagent.config.ts"), "export default {};\n");
  await writeFile(join(dir, "package.json"), `{"name":"a","private":true}\n`);
  if (miseToml !== undefined) await writeFile(join(dir, "mise.toml"), miseToml);
  return dir;
}

/**
 * A stand-in mise where this machine's platform package puts it: it logs each call (its arguments and the isolation it
 * was given), answers `env --json`, and says a system package is missing when `FAKE_MISSING` is set.
 */
async function fakeMise(dir: string): Promise<{ bin: string; calls: () => Promise<string[]> }> {
  const pkg = join(dir, "node_modules", "@jdxcode", `mise-${process.platform}-${process.arch}`);
  await mkdir(join(pkg, "bin"), { recursive: true });
  await writeFile(join(pkg, "package.json"), `{"name":"@jdxcode/mise-${process.platform}-${process.arch}"}\n`);
  const log = join(dir, "mise-calls.log");
  const bin = join(pkg, "bin", "mise");
  await writeFile(
    bin,
    `#!/bin/sh
echo "$*|$MISE_TRUSTED_CONFIG_PATHS|$MISE_CEILING_PATHS|$MISE_OVERRIDE_CONFIG_FILENAMES|$MISE_OVERRIDE_TOOL_VERSIONS_FILENAMES|$MISE_GLOBAL_CONFIG_FILE|$PWD" >> "${log}"
case "$1" in
  env) printf '{"PATH":"/fake/tools%s%s","FAKE_TOOL_HOME":"/fake/home"}' "${delimiter}" "$PATH" ;;
  bootstrap) if [ -n "$FAKE_MISSING" ]; then echo "apt  chromium  missing"; exit 1; fi ;;
  set) printf '[env]\\nA = "1"\\n' >> mise.toml ;;
  fail) exit 3 ;;
esac
`,
  );
  await chmod(bin, 0o755);
  return { bin, calls: async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean) };
}

/** A stand-in npm, for PATH: it records what it was asked and installs this platform's mise package, as npm does. */
async function fakeNpm(dir: string): Promise<string> {
  const fakeBin = await realpath(await mkdtemp(join(tmpdir(), "fa-env-npm-")));
  const pkg = join(dir, "node_modules", "@jdxcode", `mise-${process.platform}-${process.arch}`);
  await writeFile(
    join(fakeBin, "npm"),
    `#!/bin/sh\necho "$*" > "${join(dir, "npm-args")}"\nmkdir -p "${pkg}/bin" && echo '{}' > "${pkg}/package.json" && : > "${pkg}/bin/mise"\n`,
  );
  await chmod(join(fakeBin, "npm"), 0o755);
  return fakeBin;
}

describe("environment: what mise.toml may declare", () => {
  it("reads [tools] and [bootstrap.packages]; an agent without mise.toml has none", async () => {
    const dir = await agentDir(
      `[tools]\ngh = "2"\n"npm:prettier" = "3"\njq = { version = "1.8.1" }\n\n` +
        `[bootstrap.packages]\n"apt:chromium" = { os = "linux" }\n`,
    );
    expect(readEnvironment(dir)).toEqual({
      path: join(dir, "mise.toml"),
      tools: ["gh", "npm:prettier", "jq"],
      packages: ["apt:chromium"],
    });
    expect(readEnvironment(await agentDir())).toBeUndefined();
  });

  it.each([
    ["not TOML", `[tools\n`, /mise\.toml is not valid TOML/],
    ["[env]", `[env]\nA = "1"\n`, /\[env\] is not supported yet — set environment variables in \.secrets\/\.env/],
    [
      "[tasks]",
      `[tasks.build]\nrun = "x"\n`,
      /"tasks" is not supported — an agent's mise\.toml declares \[tools\] and/,
    ],
    ["[settings]", `[settings]\nlocked = false\n`, /"settings" is not supported/],
    ["a plugin backend", `[tools]\n"asdf:foo" = "1"\n`, /tool "asdf:foo" installs through a plugin/],
    ["a postinstall", `[tools]\njq = { version = "1", postinstall = "x" }\n`, /tool "jq" has a postinstall command/],
    ["other machine setup", `[bootstrap.repos]\n"~/x" = "y"\n`, /\[bootstrap\.repos\] is not supported/],
    ["[tools] not a table", `tools = "gh"\n`, /\[tools\] must be a table/],
  ])("refuses %s, naming the file", async (_what, toml, message) => {
    const dir = await agentDir(toml);
    expect(() => readEnvironment(dir)).toThrow(message);
  });
});

describe("environment: the agent's own mise", () => {
  it("is entered by a process that runs the agent: installed, then on PATH with mise itself, on mise.toml alone", async () => {
    const dir = await agentDir(`[tools]\njq = "1.8.1"\n[bootstrap.packages]\n"apt:chromium" = { os = "linux" }\n`);
    const { bin, calls } = await fakeMise(dir);
    process.env.FAKE_MISSING = "1";
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      await enterEnvironment(dir);
      expect(warn.mock.calls.flat().join("\n")).toMatch(
        /system packages mise\.toml declares are missing here \(the image installs them\):\napt {2}chromium {2}missing\n/,
      );
    } finally {
      warn.mockRestore();
    }
    const isolation = `${dir}|${join(dir, "..")}|mise.toml|none|/dev/null/none.toml|${dir}`;
    expect(await calls()).toEqual([
      `install|${isolation}`,
      `bootstrap packages status --missing|${isolation}`,
      `env --json|${isolation}`,
    ]);
    const path = (process.env.PATH ?? "").split(delimiter);
    expect(path.slice(0, 2)).toEqual([join(bin, ".."), "/fake/tools"]);
    expect(process.env.FAKE_TOOL_HOME).toBe("/fake/home");
    // The agent's own `mise use` runs as isolated as FastAgent's.
    expect(process.env.MISE_OVERRIDE_CONFIG_FILENAMES).toBe("mise.toml");
  });

  it("an agent without mise.toml borrows the machine's commands; one with it and no mise is refused", async () => {
    const before = process.env.PATH;
    await enterEnvironment(await agentDir());
    expect(process.env.PATH).toBe(before);
    const dir = await agentDir(`[tools]\njq = "1.8.1"\n`);
    await expect(enterEnvironment(dir)).rejects.toThrow(
      `${join(dir, "mise.toml")} declares an environment, and the agent has no mise installed — run \`fastagent env install\` in ${dir}`,
    );
    await expect(lockEnvironment(dir)).rejects.toThrow(/run `fastagent env install`/);
  });

  it("locks for the platforms an image is built for; nothing without mise.toml", async () => {
    const dir = await agentDir(`[tools]\njq = "1.8.1"\n`);
    const { calls } = await fakeMise(dir);
    await lockEnvironment(dir);
    expect((await calls()).map((call) => call.split("|")[0])).toEqual(["lock --platform linux-x64,linux-arm64"]);
    const none = await agentDir();
    await lockEnvironment(none);
    expect(miseBinary(none)).toBeUndefined();
  });

  it("is added to the agent's package.json, every platform pinned, by the command that changes the environment", async () => {
    const dir = await agentDir();
    const pkg = join(dir, "node_modules", "@jdxcode", `mise-${process.platform}-${process.arch}`);
    const fakeBin = await fakeNpm(dir);
    process.env.PATH = `${fakeBin}${delimiter}${process.env.PATH}`;
    const info = vi.spyOn(log, "info").mockImplementation(() => {});
    try {
      expect(await ensureMise(dir)).toBe(join(pkg, "bin", "mise"));
    } finally {
      info.mockRestore();
    }
    expect((await readFile(join(dir, "npm-args"), "utf8")).trim()).toBe(
      "install --save-optional --save-exact --no-audit --no-fund @jdxcode/mise-darwin-arm64@latest " +
        "@jdxcode/mise-darwin-x64@latest @jdxcode/mise-linux-arm64@latest @jdxcode/mise-linux-x64@latest",
    );
  });

  it("a clone that lists mise and has not installed its dependencies keeps the version it pins", async () => {
    const dir = await agentDir();
    const optionalDependencies = Object.fromEntries(MISE_PACKAGE_NAMES.map((name) => [name, "2026.10.7"]));
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "a", private: true, optionalDependencies }));
    const fakeBin = await fakeNpm(dir);
    process.env.PATH = `${fakeBin}${delimiter}${process.env.PATH}`;
    vi.spyOn(log, "info").mockImplementation(() => {});
    try {
      await ensureMise(dir);
    } finally {
      vi.restoreAllMocks();
    }
    expect((await readFile(join(dir, "npm-args"), "utf8")).trim()).toBe("install --no-audit --no-fund");
  });
});

describe("environment: `fastagent env`", () => {
  const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const cli = (args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, ...args], { cwd });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });

  it("hands everything to the agent's mise, exits as it does, and says at once what FastAgent will refuse", async () => {
    const dir = await agentDir(`[tools]\njq = "1.8.1"\n`);
    const { calls } = await fakeMise(dir);
    const ls = await cli(["env", "--locked", "ls", "--json"], dir);
    expect(ls.code, ls.stderr).toBe(0);
    expect((await calls()).at(-1)).toMatch(/^--locked ls --json\|/);
    expect((await cli(["env", "fail"], dir)).code).toBe(3);
    const set = await cli(["env", "set", "A=1"], dir);
    expect([set.code, set.stderr]).toEqual([1, expect.stringMatching(/\[env\] is not supported yet/)]);
  });
});
