/**
 * The environment (src/environment/): what the `environment` of context.json may declare, how FastAgent renders and
 * locks it in environment/ with the agent's own mise, and how a process that runs the agent enters it. mise itself is a
 * stand-in here, a script at the path the agent's platform package would put it: what is tested is FastAgent's side
 * (which file, which isolation, which arguments, in which order, what reaches the process), not mise.
 */
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contextFileText, parseContextFile } from "../src/content/file.ts";
import { aptAdvice, missingAptPackages } from "../src/environment/apt.ts";
import {
  declareEnvironment,
  declaresTool,
  missingPythonRuntime,
  packagesDigest,
  parsePackageArgument,
  resolvedBackendRefusal,
  runtimeAdvice,
} from "../src/environment/declare.ts";
import {
  checkPackages,
  ensureMise,
  enterEnvironment,
  lockEnvironment,
  MISE_PACKAGE_NAMES,
  miseBinary,
  RENDERED_CONFIG_HEADER,
} from "../src/environment/mise.ts";
import { addContent, writeEnvironment } from "../src/harnesses/pi/authoring.ts";
import { resolveAgentAssembly } from "../src/harnesses/pi/open.ts";
import { log } from "../src/log.ts";

const savedEnv = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  vi.restoreAllMocks();
});

const FASTAGENT = { "@fastagent-sh/fastagent": "^0.24.4" };

async function agentDir(environment?: unknown): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "fa-env-")));
  await writeFile(join(dir, "fastagent.config.ts"), "export default {};\n");
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "a", private: true, dependencies: FASTAGENT }));
  if (environment !== undefined) await writeFile(join(dir, "context.json"), JSON.stringify({ environment }));
  return dir;
}

/** `environment/` as `fastagent env` leaves it for `packages`: what a process that runs the agent accepts. */
async function locked(dir: string, packages: Record<string, string>): Promise<void> {
  await mkdir(join(dir, "environment"), { recursive: true });
  await writeFile(join(dir, "environment", "mise.toml"), `${RENDERED_CONFIG_HEADER}[tools]\n`);
  await writeFile(join(dir, "environment", "packages.sha256"), `${packagesDigest(packages)}\n`);
}

/**
 * A stand-in mise where this machine's platform package puts it. It logs each call (its arguments, the isolation it was
 * given, where it ran), and at `lock` what context.json held then; answers `tool <name> --json` and `env --json`;
 * fails `install` when `FAKE_FAIL_INSTALL` is set, and sleeps in it when `FAKE_SLOW` is.
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
  install) if [ -n "$FAKE_SLOW" ]; then sleep 2; fi
    if [ -n "$FAKE_FAIL_INSTALL" ]; then echo "mise ERROR no version of jq matches 99" >&2; exit 1; fi ;;
  lock) echo "context.json at lock: $(cat ../context.json 2>/dev/null | tr -d ' \\n')" >> "${log}"
    if [ "$2" = --bump ]; then version=2.90.0; else version=2.83.1; fi
    printf '[[tools.gh]]\\nversion = "%s"\\n' "$version" > mise.lock
    mkdir -p .mise/locks/npm-prettier/3.6.2 && echo '{}' > .mise/locks/npm-prettier/3.6.2/package.json ;;
  tool) case "$2" in
      tokei) echo '{"backend":"cargo:tokei"}' ;;
      ansible) echo '{"backend":"pypi:ansible"}' ;;
      nope) echo "mise ERROR nope not found in mise tool registry" >&2; exit 1 ;;
      *) printf '{"backend":"aqua:owner/%s"}' "$2" ;;
    esac ;;
  --locked) if [ "$2" = env ]; then printf '{"PATH":"/fake/tools%s%s","FAKE_TOOL_HOME":"/fake/home"}' "${delimiter}" "$PATH"; fi ;;
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

describe("environment: what context.json may declare", () => {
  it("reads packages and aptPackages; an agent that declares none has no environment", () => {
    expect(declareEnvironment(undefined)).toBeUndefined();
    expect(
      declareEnvironment({
        packages: { gh: "2", "npm:@biomejs/biome": "latest", "aqua:jqlang/jq": "1.8.1", python: "3.12" },
        aptPackages: ["chromium", "fonts-noto-cjk", "libstdc++6"],
      }),
    ).toEqual({
      packages: { gh: "2", "npm:@biomejs/biome": "latest", "aqua:jqlang/jq": "1.8.1", python: "3.12" },
      aptPackages: ["chromium", "fonts-noto-cjk", "libstdc++6"],
    });
  });

  it("refuses what it does not hold, each by name and with its reason", () => {
    const refused = (environment: unknown) => () => declareEnvironment(environment);
    expect(refused([])).toThrow(`"environment" must be an object`);
    expect(refused({ variables: {} })).toThrow(
      `environment: unknown key "variables" (valid keys: packages, aptPackages)`,
    );
    expect(refused({ packages: { "cargo:ripgrep": "14" } })).toThrow(
      `package "cargo:ripgrep" installs with cargo:, which builds from source: a whole Rust toolchain in the image ` +
        `for one binary — write the project's release with github:<owner>/<repo>, or install it in your own ` +
        `Dockerfile`,
    );
    expect(refused({ packages: { "vfox:jdx/vfox-php": "8" } })).toThrow(
      /runs a plugin's code .* the lock does not pin it/,
    );
    expect(refused({ packages: { "s3:bucket/tool": "1" } })).toThrow(
      /installs with s3:, which FastAgent does not install from/,
    );
    expect(refused({ packages: { "http:tool": "1" } })).toThrow(/needs a URL a version cannot hold/);
    expect(refused({ packages: { "github:o/r[bin=x]": "1" } })).toThrow(/has mise's \[options\]/);
    expect(refused({ packages: { "two words": "1" } })).toThrow(/is not a name from mise's registry/);
    expect(refused({ packages: { gh: "ref:main" } })).toThrow(`version "ref:main" — a version is "latest"`);
    expect(refused({ packages: { gh: "system" } })).toThrow(`version "system"`);
    expect(refused({ packages: { gh: "" } })).toThrow(`the version must be non-empty`);
    expect(refused({ packages: { gh: 2 } })).toThrow(`package "gh": the version must be a string`);
    expect(refused({ aptPackages: ["Chromium"] })).toThrow(`apt package "Chromium" is not a Debian package name`);
    expect(refused({ aptPackages: ["git", "git"] })).toThrow(`apt package "git" is listed twice`);
  });

  it("is read and written with the rest of context.json, an empty one left out", async () => {
    const path = "/a/context.json";
    expect(() => parseContextFile(`{"environment":{"packages":{"gh":"x y"}}}`, path)).toThrow(
      `${path}: environment: package "gh": the version must be non-empty, without spaces`,
    );
    const file = parseContextFile(`{"content":{},"environment":{"packages":{"gh":"2"}}}`, path);
    expect(file.environment).toEqual({ packages: { gh: "2" }, aptPackages: [] });
    expect(JSON.parse(contextFileText(file))).toEqual({ content: {}, environment: { packages: { gh: "2" } } });
    expect(JSON.parse(contextFileText({ content: {}, environment: { packages: {}, aptPackages: [] } }))).toEqual({
      content: {},
    });
    // The two edits keep each other's part of the file.
    const dir = await agentDir();
    const elsewhere = await realpath(await mkdtemp(join(tmpdir(), "fa-env-content-")));
    await writeEnvironment(dir, { packages: { gh: "2" }, aptPackages: ["chromium"] });
    await addContent(dir, { name: "notes", entry: {}, link: elsewhere });
    await writeEnvironment(dir, { packages: { jq: "latest" }, aptPackages: [] });
    expect(JSON.parse(await readFile(join(dir, "context.json"), "utf8"))).toEqual({
      content: { notes: {} },
      environment: { packages: { jq: "latest" } },
    });
  });

  it("refuses a registry name by the backend mise resolves it to, unless that backend is allowed", () => {
    for (const backend of ["aqua:jqlang/jq", "github:cli/cli", "core:python", "pypi:ansible", "packslip:x/y"]) {
      expect(resolvedBackendRefusal("x", backend), backend).toBeUndefined();
    }
    expect(resolvedBackendRefusal("tokei", "cargo:tokei")).toMatch(
      /^package "tokei" resolves to cargo:tokei, which builds from source: .* — write the project's release with github:/,
    );
    expect(resolvedBackendRefusal("php", "vfox:jdx/vfox-php")).toMatch(
      /resolves to vfox:jdx\/vfox-php, which runs a plugin's code/,
    );
    expect(resolvedBackendRefusal("x", "newthing:x")).toMatch(
      /resolves to newthing:x, which FastAgent does not install from/,
    );
  });

  it("names the PyPI packages whose python and uv it leaves to the machine", () => {
    const kinds = new Map([
      ["pypi:markitdown", "pypi"],
      ["ansible", "pypi"],
      ["gh", "aqua"],
    ]);
    const missing = missingPythonRuntime({ "pypi:markitdown": "latest", ansible: "11", gh: "2" }, kinds);
    expect(missing).toEqual({ packages: ["pypi:markitdown", "ansible"], missing: ["python", "uv"] });
    expect(runtimeAdvice(missing!)).toBe(
      "pypi:markitdown, ansible install with python and uv, which the environment does not declare: mise then uses " +
        "this machine's, and the image has none — run `fastagent env add python uv`",
    );
    // A runtime under any backend or owner counts.
    const declared = { "pypi:markitdown": "latest", python: "3.12", "aqua:astral-sh/uv": "latest" };
    expect(missingPythonRuntime(declared, kinds)).toBeUndefined();
    expect(declaresTool(declared, "uv")).toBe(true);
    expect(missingPythonRuntime({ gh: "2" }, kinds)).toBeUndefined();
  });

  it("digests the packages whatever their order, and reads `fastagent env add` arguments", () => {
    expect(packagesDigest({ a: "1", b: "2" })).toBe(packagesDigest({ b: "2", a: "1" }));
    expect(packagesDigest({ a: "1" })).not.toBe(packagesDigest({ a: "2" }));
    expect(parsePackageArgument("gh")).toEqual({ name: "gh", version: "latest" });
    expect(parsePackageArgument("gh@2")).toEqual({ name: "gh", version: "2" });
    expect(parsePackageArgument("npm:@biomejs/biome")).toEqual({ name: "npm:@biomejs/biome", version: "latest" });
    expect(parsePackageArgument("npm:@biomejs/biome@2")).toEqual({ name: "npm:@biomejs/biome", version: "2" });
    expect(parsePackageArgument("apt:chromium")).toEqual({ apt: "chromium" });
  });
});

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
    expect(aptAdvice(["chromium"])).toBe(
      "the image installs apt packages this machine does not have: chromium — `sudo apt-get install -y chromium`",
    );
  });
});

describe("environment: environment/, its lock", () => {
  it("is rendered from the packages, installed here, locked for every platform, and digested last", async () => {
    const dir = await agentDir({ packages: { gh: "2" } });
    const { bin, calls } = await fakeMise(dir);
    const order: string[] = [];
    await lockEnvironment(dir, { gh: "2", "npm:prettier": "3" }, bin, async () => {
      order.push((await readFile(join(dir, "environment", "packages.sha256"), "utf8")).trim());
    });
    expect(await readFile(join(dir, "environment", "mise.toml"), "utf8")).toBe(
      `# Rendered by FastAgent from the "environment" of context.json: change that (fastagent env), not this file.\n` +
        `[settings.python]\ncompile = false\n\n[settings.ruby]\ncompile = false\n\n[settings.node]\ncompile = false\n\n` +
        `[settings.erlang]\ncompile = false\n\n[tools]\ngh = "2"\n"npm:prettier" = "3"\n`,
    );
    // The declaration is committed once the lock is in place, digest included.
    expect(order).toEqual([packagesDigest({ gh: "2", "npm:prettier": "3" })]);
    // Trusted: environment/mise.toml alone; the agent directory is the ceiling, so a mise.toml there is not read.
    const isolation = `${join(dir, "environment", "mise.toml")}|${dir}|mise.toml|none|/dev/null/none.toml|${join(dir, "environment")}`;
    expect((await calls()).filter((call) => !call.startsWith("context.json"))).toEqual([
      `install|${isolation}`,
      `lock --platform linux-x64,linux-arm64,macos-x64,macos-arm64|${isolation}`,
    ]);
  });

  it("is put back as it was when mise or the commit fails, and removed when no package is left", async () => {
    const dir = await agentDir();
    const { bin } = await fakeMise(dir);
    await lockEnvironment(dir, { gh: "2" }, bin);
    const before = await readFile(join(dir, "environment", "mise.lock"), "utf8");
    process.env.FAKE_FAIL_INSTALL = "1";
    const commit = vi.fn(async () => {});
    await expect(lockEnvironment(dir, { gh: "2", jq: "99" }, bin, commit)).rejects.toThrow(
      "mise install failed (exit 1)",
    );
    expect(commit).not.toHaveBeenCalled();
    delete process.env.FAKE_FAIL_INSTALL;
    await expect(
      lockEnvironment(dir, { jq: "1" }, bin, async () => {
        throw new Error("context.json is locked");
      }),
    ).rejects.toThrow("context.json is locked");
    for (const _ of [0, 1]) {
      expect(await readFile(join(dir, "environment", "mise.toml"), "utf8")).toContain(`gh = "2"`);
      expect(await readFile(join(dir, "environment", "mise.lock"), "utf8")).toBe(before);
      expect((await readFile(join(dir, "environment", "packages.sha256"), "utf8")).trim()).toBe(
        packagesDigest({ gh: "2" }),
      );
    }
    await lockEnvironment(dir, {}, undefined);
    await expect(stat(join(dir, "environment"))).rejects.toThrow(/ENOENT/);
  });

  it("is FastAgent's only by its rendered configuration: an author's environment/ is ignored, refused, never removed", async () => {
    const notes = async (dir: string) => {
      await mkdir(join(dir, "environment"), { recursive: true });
      await writeFile(join(dir, "environment", "notes.md"), "mine\n");
    };
    // Without packages it is not in the way: nothing refuses it, and nothing removes it.
    const quiet = await agentDir({ aptPackages: ["chromium"] });
    await notes(quiet);
    await enterEnvironment(quiet);
    await lockEnvironment(quiet, {}, undefined);
    expect(await readFile(join(quiet, "environment", "notes.md"), "utf8")).toBe("mine\n");
    // With packages it is where their lock goes: the start and the lock refuse it, and leave it as it is.
    const dir = await agentDir({ packages: { gh: "2" } });
    await notes(dir);
    await writeFile(join(dir, "environment", "mise.toml"), "[tools]\n");
    const { bin } = await fakeMise(dir);
    const foreign = `${join(dir, "environment")} was not written by FastAgent (it holds no mise.toml rendered from context.json)`;
    await expect(enterEnvironment(dir)).rejects.toThrow(foreign);
    await expect(lockEnvironment(dir, { gh: "2" }, bin)).rejects.toThrow(foreign);
    expect(await readdir(join(dir, "environment"))).toEqual(["mise.toml", "notes.md"]);
    // FastAgent's own, with a file of the author's beside: removing the last package removes only FastAgent's files.
    await rm(join(dir, "environment"), { recursive: true });
    await lockEnvironment(dir, { gh: "2" }, bin);
    await writeFile(join(dir, "environment", "notes.md"), "mine\n");
    await lockEnvironment(dir, {}, undefined);
    expect(await readdir(join(dir, "environment"))).toEqual(["notes.md"]);
  });

  it("checks each package by its backend: a written one says it, mise resolves a registry name", async () => {
    const dir = await agentDir();
    const { bin, calls } = await fakeMise(dir);
    const check = await checkPackages(dir, bin, { tokei: "12", ansible: "11", "pypi:markitdown": "1", gh: "2" });
    expect(check.refusals).toEqual([expect.stringMatching(/^package "tokei" resolves to cargo:tokei, which builds/)]);
    expect(check.runtime).toEqual({ packages: ["ansible", "pypi:markitdown"], missing: ["python", "uv"] });
    expect((await calls()).map((call) => call.split("|")[0]).sort()).toEqual([
      "tool ansible --json",
      "tool gh --json",
      "tool tokei --json",
    ]);
    await expect(checkPackages(dir, bin, { nope: "1" })).rejects.toThrow(
      "mise tool nope --json failed (exit 1): nope not found in mise tool registry",
    );
  });
});

describe("environment: entered by a process that runs the agent", () => {
  it("installs the locked versions and puts them on PATH, writing nothing", async () => {
    const dir = await agentDir({ packages: { gh: "2" } });
    await locked(dir, { gh: "2" });
    const { calls } = await fakeMise(dir);
    await enterEnvironment(dir);
    const isolation = `${join(dir, "environment", "mise.toml")}|${dir}|mise.toml|none|/dev/null/none.toml|${join(dir, "environment")}`;
    expect(await calls()).toEqual([`--locked install|${isolation}`, `--locked env --json|${isolation}`]);
    expect((process.env.PATH ?? "").split(delimiter)[0]).toBe("/fake/tools");
    expect(process.env.FAKE_TOOL_HOME).toBe("/fake/home");
    // The isolation is these runs' alone, and the agent's mise is not on the PATH.
    for (const name of ["MISE_TRUSTED_CONFIG_PATHS", "MISE_CEILING_PATHS", "MISE_OVERRIDE_CONFIG_FILENAMES"]) {
      expect(process.env[name], name).toBe(savedEnv[name]);
    }
    expect(process.env.PATH).not.toContain(join(dir, "node_modules"));
    expect(await readdir(join(dir, "environment"))).toEqual(["mise.toml", "packages.sha256"]);
  });

  it("refuses an environment/ that is not the lock of what context.json declares, naming the fix", async () => {
    const before = process.env.PATH;
    await enterEnvironment(await agentDir());
    expect(process.env.PATH).toBe(before);
    const dir = await agentDir({ packages: { gh: "2" } });
    const fix = `run \`fastagent env install\` in ${dir}, then commit environment/`;
    await expect(enterEnvironment(dir)).rejects.toThrow(
      `context.json declares packages, and environment/ has no lock for them — ${fix}`,
    );
    await locked(dir, { gh: "1" });
    await expect(enterEnvironment(dir)).rejects.toThrow(
      `the packages context.json declares are not the ones environment/ was locked for — ${fix}`,
    );
    const left = await agentDir({ aptPackages: ["chromium"] });
    await locked(left, { gh: "2" });
    await expect(enterEnvironment(left)).rejects.toThrow(
      `environment/ is left from packages context.json no longer declares — run \`fastagent env install\` in ${left}`,
    );
    // The lock matches, and there is no mise to install it with.
    await locked(dir, { gh: "2" });
    expect(miseBinary(dir)).toBeUndefined();
    await expect(enterEnvironment(dir)).rejects.toThrow(
      `context.json declares packages, and the agent has no mise installed — run \`fastagent env install\` in ${dir}`,
    );
  });

  it("is entered by the assembly, so every process that opens the agent has it: createAgentService and chat too", async () => {
    await expect(resolveAgentAssembly(await agentDir({ packages: { gh: "2" } }))).rejects.toThrow(
      /environment\/ has no lock for them/,
    );
    const dir = await agentDir({ packages: { gh: "2" } });
    await locked(dir, { gh: "2" });
    await fakeMise(dir);
    await resolveAgentAssembly(dir);
    expect((process.env.PATH ?? "").split(delimiter)[0]).toBe("/fake/tools");
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

  it("is not added to an agent whose package.json does not list FastAgent: its image could not start", async () => {
    const dir = await agentDir();
    const fakeBin = await fakeNpm(dir);
    process.env.PATH = `${fakeBin}${delimiter}${process.env.PATH}`;
    for (const manifest of [undefined, `{"name":"a"}`]) {
      await rm(join(dir, "package.json"), { force: true });
      if (manifest) await writeFile(join(dir, "package.json"), manifest);
      await expect(ensureMise(dir)).rejects.toThrow(
        `${join(dir, "package.json")} does not list @fastagent-sh/fastagent — the agent's mise is one of its ` +
          "dependencies, and an agent with dependencies runs the FastAgent they list. Add it first: " +
          `\`npm install @fastagent-sh/fastagent\` in ${dir}`,
      );
    }
    await expect(readFile(join(dir, "npm-args"), "utf8")).rejects.toThrow(/ENOENT/);
  });
});

describe("environment: `fastagent env`", () => {
  const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const cli = (
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

  it("adds packages: locked first, declared last; an apt package is declared without mise", async () => {
    const dir = await agentDir();
    await writeFile(join(dir, "context.json"), `{"content":{}}`);
    const { calls } = await fakeMise(dir);
    const add = await cli(["env", "add", "gh@2", "npm:prettier@3"], dir);
    expect(add.code, add.stderr).toBe(0);
    expect(await declared(dir)).toEqual({ packages: { gh: "2", "npm:prettier": "3" } });
    // At lock time the declaration was not written yet.
    expect(await calls()).toContain(`context.json at lock: {"content":{}}`);
    expect(await readdir(join(dir, "environment"))).toEqual([".mise", "mise.lock", "mise.toml", "packages.sha256"]);
    const before = (await calls()).length;
    const apt = await cli(["env", "add", "apt:chromium"], dir);
    expect(apt.code, apt.stderr).toBe(0);
    expect(await declared(dir)).toEqual({ packages: { gh: "2", "npm:prettier": "3" }, aptPackages: ["chromium"] });
    expect((await calls()).length).toBe(before);
  });

  it("refuses a package FastAgent does not install from, and one mise cannot install, changing nothing", async () => {
    const dir = await agentDir({ packages: { gh: "2" } });
    await fakeMise(dir);
    expect((await cli(["env", "install"], dir)).code).toBe(0);
    const lock = await readFile(join(dir, "environment", "mise.lock"), "utf8");
    const tokei = await cli(["env", "add", "tokei"], dir);
    expect(tokei.code).toBe(1);
    expect(tokei.stderr).toMatch(/package "tokei" resolves to cargo:tokei, which builds from source/);
    const vfox = await cli(["env", "add", "vfox:jdx/vfox-php"], dir);
    expect(vfox.code).toBe(1);
    expect(vfox.stderr).toMatch(/installs with vfox:, which runs a plugin's code/);
    const failing = await cli(["env", "add", "jq@99"], dir, { FAKE_FAIL_INSTALL: "1" });
    expect(failing.code).toBe(1);
    expect(failing.stderr).toContain("mise ERROR no version of jq matches 99");
    expect(failing.stderr).toContain("mise install failed (exit 1)");
    expect(await declared(dir)).toEqual({ packages: { gh: "2" } });
    expect(await readFile(join(dir, "environment", "mise.lock"), "utf8")).toBe(lock);
  });

  it("removes packages, environment/ with the last one; a package it does not have is named", async () => {
    const dir = await agentDir({ packages: { gh: "2" }, aptPackages: ["chromium"] });
    await locked(dir, { gh: "2" });
    await fakeMise(dir);
    for (const name of ["jq", "toString"]) {
      const unknown = await cli(["env", "remove", name], dir);
      expect(unknown.code, name).toBe(1);
      expect(unknown.stderr).toContain(`the environment has no package "${name}" (it has: gh, apt:chromium)`);
    }
    const remove = await cli(["env", "remove", "gh", "apt:chromium"], dir);
    expect(remove.code, remove.stderr).toBe(0);
    expect(await declared(dir)).toBeUndefined();
    await expect(stat(join(dir, "environment"))).rejects.toThrow(/ENOENT/);
  });

  it("install locks again what context.json changed by hand, says so, then installs the lock", async () => {
    const dir = await agentDir({ packages: { gh: "2" } });
    await locked(dir, { gh: "1" });
    const { calls } = await fakeMise(dir);
    const install = await cli(["env", "install"], dir);
    expect(install.code, install.stderr).toBe(0);
    expect(install.stderr).toContain("environment/ is locked again from context.json — commit it");
    expect(
      (await calls()).map((call) => call.split("|")[0] ?? call).filter((call) => !call.startsWith("context.json")),
    ).toEqual([
      "tool gh --json",
      "install",
      "lock --platform linux-x64,linux-arm64,macos-x64,macos-arm64",
      "--locked install",
      "--locked env --json",
    ]);
  });

  it("updates a locked version only when asked: the declaration stays, the lock moves, and says so", async () => {
    const dir = await agentDir({ packages: { gh: "latest" }, aptPackages: ["chromium"] });
    const { calls } = await fakeMise(dir);
    expect((await cli(["env", "install"], dir)).code).toBe(0);
    const before = (await calls()).length;
    const update = await cli(["env", "update", "gh"], dir);
    expect(update.code, update.stderr).toBe(0);
    expect(update.stdout).toBe("gh  2.83.1 → 2.90.0\n");
    expect(update.stderr).toContain("commit environment/; a running `fastagent dev` uses the new versions");
    expect((await calls()).slice(before).map((call) => call.split("|")[0] ?? call)).toEqual([
      "tool gh --json",
      "--locked install",
      "lock --bump gh --platform linux-x64,linux-arm64,macos-x64,macos-arm64",
      expect.stringMatching(/^context\.json at lock: /),
      "--locked install",
    ]);
    expect(await declared(dir)).toEqual({ packages: { gh: "latest" }, aptPackages: ["chromium"] });
    for (const [name, error] of [
      ["jq", `the environment has no package "jq" (it has: gh, apt:chromium)`],
      ["apt:chromium", "apt:chromium is not locked: the image installs the version its Debian release has"],
    ] as const) {
      const refused = await cli(["env", "update", name], dir);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain(error);
    }
  });

  it("lists the packages with their locked versions, and what is wrong with them", async () => {
    const dir = await agentDir({
      packages: { gh: "2", tokei: "12", "pypi:markitdown": "1" },
      aptPackages: ["chromium"],
    });
    await fakeMise(dir);
    await mkdir(join(dir, "environment"));
    await writeFile(join(dir, "environment", "mise.toml"), `${RENDERED_CONFIG_HEADER}[tools]\n`);
    await writeFile(join(dir, "environment", "mise.lock"), `[[tools.gh]]\nversion = "2.83.1"\n`);
    const list = await cli(["env", "list"], dir);
    expect(list.code, list.stderr).toBe(0);
    expect(list.stdout).toBe(
      [
        "gh               2         2.83.1",
        "tokei            12        (not locked)",
        "pypi:markitdown  1         (not locked)",
        "apt:chromium     (installed by the image)",
        "",
      ].join("\n"),
    );
    expect(list.stderr).toMatch(/has no lock for them/);
    expect(list.stderr).toMatch(/package "tokei" resolves to cargo:tokei/);
    expect(list.stderr).toMatch(/pypi:markitdown installs with python and uv/);
  });

  it("runs a command in the environment, and exits as it does", async () => {
    const dir = await agentDir({ packages: { gh: "2" } });
    await locked(dir, { gh: "2" });
    await fakeMise(dir);
    const exec = await cli(["env", "exec", "--", "sh", "-c", 'echo "$PATH"; exit 3'], dir);
    expect(exec.code).toBe(3);
    expect(exec.stdout.split(delimiter)[0]).toBe("/fake/tools");
    // The command's arguments are its own, an empty one included.
    const empty = await cli(["env", "exec", "--", "sh", "-c", 'printf "[%s]" "$1"', "sh", ""], dir);
    expect(empty.code, empty.stderr).toBe(0);
    expect(empty.stdout).toBe("[]");
    const missing = await cli(["env", "exec", "--", "no-such-command-here"], dir);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("no-such-command-here: command not found in the environment");
  });

  it("puts environment/ back when interrupted mid-install, so the next start is not the one to find it", async () => {
    const dir = await agentDir({ aptPackages: ["chromium"] });
    const { calls } = await fakeMise(dir);
    const child = spawn(process.execPath, [CLI, "env", "add", "gh@2"], {
      cwd: dir,
      env: { ...process.env, FAKE_SLOW: "1" },
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
    while (!(await calls()).some((call) => call.startsWith("install"))) await new Promise((r) => setTimeout(r, 50));
    child.kill("SIGINT");
    expect(await exited).toBe(1);
    expect(stderr).toContain(`interrupted by SIGINT: ${join(dir, "environment")} is put back as it was`);
    await expect(stat(join(dir, "environment"))).rejects.toThrow(/ENOENT/);
    expect(await declared(dir)).toEqual({ aptPackages: ["chromium"] });
    await enterEnvironment(dir);
  }, 30_000);

  it("runs one at a time, so a second change starts from the first", async () => {
    const dir = await agentDir();
    const { calls } = await fakeMise(dir);
    const first = cli(["env", "add", "gh@2"], dir, { FAKE_SLOW: "1" });
    while (!(await calls()).some((call) => call.startsWith("install"))) await new Promise((r) => setTimeout(r, 50));
    const second = await cli(["env", "add", "jq@1"], dir);
    expect((await first).code).toBe(0);
    expect(second.code, second.stderr).toBe(0);
    expect(second.stderr).toContain("waiting for another `fastagent env` on this agent to finish");
    expect(await declared(dir)).toEqual({ packages: { gh: "2", jq: "1" } });
    await expect(stat(join(dir, "environment.lock"))).rejects.toThrow(/ENOENT/);
  }, 30_000);
});
