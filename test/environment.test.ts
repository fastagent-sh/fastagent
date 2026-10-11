/**
 * The environment (src/environment/): what the `environment` of context.json may declare, how FastAgent locks it into
 * environment/ with the agent's own mise, and how a process that runs the agent enters it. mise itself is a stand-in
 * here, a script at the path the agent's platform package would put it: what is tested is FastAgent's side (which
 * file, which isolation, which arguments, where, in which order, what reaches the process), not mise. What mise itself
 * does is test/live/environment.live.test.ts's.
 */
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contextFileText, parseContextFile } from "../src/content/file.ts";
import { aptAdvice, missingAptPackages } from "../src/environment/apt.ts";
import {
  declareEnvironment,
  declaredVariables,
  declaresTool,
  missingPythonRuntime,
  parsePackageArgument,
  resolvedBackendRefusal,
  runtimeAdvice,
  samePackages,
} from "../src/environment/declare.ts";
import {
  checkPackages,
  ensureMise,
  enterEnvironment,
  lockEnvironment,
  lockedVersions,
  MISE_PACKAGE_NAMES,
  miseBinary,
  removeEnvironment,
  withEnvironmentLock,
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
const PLATFORMS = "--platform linux-x64,linux-arm64";

async function agentDir(environment?: unknown): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "fa-env-")));
  await writeFile(join(dir, "fastagent.config.ts"), "export default {};\n");
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "a", private: true, dependencies: FASTAGENT }));
  if (environment !== undefined) await writeFile(join(dir, "context.json"), JSON.stringify({ environment }));
  return dir;
}

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

/** One logged mise run: its arguments, the isolation it was given, where it ran, and whether a lock was there. */
interface MiseCall {
  args: string;
  trusted: string;
  ceiling: string;
  cwd: string;
  lock: "locked" | "unlocked";
}

/**
 * A stand-in mise where this machine's platform package puts it. It logs each run, and at `lock` what the agent's
 * context.json held then. `install` adds a line to a lock it finds, as a real install adds this machine's platform;
 * `lock` writes one entry per tool in the configuration, at 2.83.1, or 2.90.0 with `--bump` or when the lock it
 * replaces has that (a lock keeps what it recorded), and a sidecar. It answers `tool <name> --json` and `env --json`,
 * fails `install` when `FAKE_FAIL_INSTALL` is set, and sleeps in it when `FAKE_SLOW` is.
 */
async function fakeMise(
  dir: string,
): Promise<{ bin: string; calls: () => Promise<MiseCall[]>; log: () => Promise<string> }> {
  const pkg = join(dir, "node_modules", "@jdxcode", `mise-${process.platform}-${process.arch}`);
  await mkdir(join(pkg, "bin"), { recursive: true });
  await writeFile(join(pkg, "package.json"), `{"name":"@jdxcode/mise-${process.platform}-${process.arch}"}\n`);
  const logFile = join(dir, "..", `${dir.split("/").at(-1)}-mise.log`);
  const bin = join(pkg, "bin", "mise");
  await writeFile(
    bin,
    `#!/bin/sh
if [ -f mise.lock ]; then lock=locked; else lock=unlocked; fi
echo "run|$*|$MISE_TRUSTED_CONFIG_PATHS|$MISE_CEILING_PATHS|$PWD|$lock|$MISE_OVERRIDE_CONFIG_FILENAMES|$MISE_OVERRIDE_TOOL_VERSIONS_FILENAMES|$MISE_GLOBAL_CONFIG_FILE" >> "${logFile}"
case "$1" in
  install) if [ -n "$FAKE_SLOW" ]; then sleep 2; fi
    if [ -n "$FAKE_FAIL_INSTALL" ]; then echo "mise ERROR no version of jq matches 99" >&2; exit 1; fi
    if [ -f mise.lock ]; then echo "# this machine's platform" >> mise.lock; fi ;;
  lock) echo "context.json at lock: $(cat "${dir}/context.json" 2>/dev/null | tr -d ' \\n')" >> "${logFile}"
    if [ "$2" = --bump ] || grep -q 2.90.0 mise.lock 2>/dev/null; then v=2.90.0; else v=2.83.1; fi
    awk -v v="$v" 'f && /=/ { gsub(/"/, "", $1); print "[[tools.\\"" $1 "\\"]]"; print "version = \\"" v "\\"" } /^\\[tools\\]/ { f = 1 }' mise.toml > mise.lock
    mkdir -p .mise/locks/npm-prettier/3.6.2 && echo '{}' > .mise/locks/npm-prettier/3.6.2/package.json ;;
  tool) case "$2" in
      tokei) echo '{"backend":"cargo:tokei"}' ;;
      ansible) echo '{"backend":"pypi:ansible"}' ;;
      nope) echo "mise ERROR nope not found in mise tool registry" >&2; exit 1 ;;
      *) printf '{"backend":"aqua:owner/%s"}' "$2" ;;
    esac ;;
  env) printf '{"PATH":"/fake/tools%s%s","FAKE_TOOL_HOME":"/fake/home"}' "${delimiter}" "$PATH" ;;
esac
`,
  );
  await chmod(bin, 0o755);
  const log = async () => readFile(logFile, "utf8").catch(() => "");
  const calls = async () =>
    (await log())
      .split("\n")
      .filter((line) => line.startsWith("run|"))
      .map((line) => {
        const [, args, trusted, ceiling, cwd, lock] = line.split("|") as string[];
        return { args, trusted, ceiling, cwd, lock } as MiseCall;
      });
  return { bin, calls, log };
}

/** `environment/` as `fastagent env add` leaves it for `packages`, through a stand-in mise of its own. */
async function locked(dir: string, packages: Record<string, string>): Promise<void> {
  const { bin } = await fakeMise(dir);
  await lockEnvironment(dir, packages, async () => bin);
  await rm(join(dir, "..", `${dir.split("/").at(-1)}-mise.log`), { force: true });
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
  it("reads packages, aptPackages and variables; an agent that declares none has no environment", () => {
    expect(declareEnvironment(undefined)).toBeUndefined();
    const environment = {
      packages: { gh: "2", "npm:@biomejs/biome": "latest", "aqua:jqlang/jq": "1.8.1", python: "3.12" },
      aptPackages: ["chromium", "fonts-noto-cjk", "libstdc++6"],
      variables: { GITHUB_TOKEN: { description: "gh's token, with repo scope" }, http_proxy: { description: "x" } },
    };
    expect(declareEnvironment(environment)).toEqual(environment);
    // A variable is declared by name, with what it is for; its value comes from the environment.
    expect(declaredVariables(declareEnvironment(environment))).toEqual([
      { name: "GITHUB_TOKEN", source: "context.json", description: "gh's token, with repo scope" },
      { name: "http_proxy", source: "context.json", description: "x" },
    ]);
  });

  it("refuses what it does not hold, each by name and with its reason", () => {
    const refused = (environment: unknown) => () => declareEnvironment(environment);
    expect(refused([])).toThrow(`"environment" must be an object`);
    expect(refused({ secrets: {} })).toThrow(
      `environment: unknown key "secrets" (valid keys: packages, aptPackages, variables)`,
    );
    // A string where the description goes reads as a value, which context.json never holds.
    expect(refused({ variables: { GH_HOST: "github.example.com" } })).toThrow(
      `environment: variable "GH_HOST" must be { "description": "what it is for" }: its value goes in the stage's ` +
        `value file (.secrets/.env, .secrets/production/.env) or the host, never in context.json`,
    );
    expect(refused({ variables: { GH_HOST: { description: "x", value: "y" } } })).toThrow(
      `variable "GH_HOST": unknown key "value" (valid keys: description)`,
    );
    expect(refused({ variables: { GH_HOST: { description: " " } } })).toThrow(`"description" must be a non-empty`);
    // Runbooks print it as a comment line: a line break would end the comment and leave a command to paste.
    expect(refused({ variables: { GH_TOKEN: { description: "gh's token\nfly apps destroy x" } } })).toThrow(
      `variable "GH_TOKEN": "description" must be one line of text, without control characters`,
    );
    expect(refused({ variables: { "MY KEY": { description: "x" } } })).toThrow(`is not an environment variable name`);
    // The deployment sets these itself, and never carries a value file's copy: a declaration could never be met.
    for (const name of ["PORT", "FASTAGENT_MODEL", "FASTAGENT_STATE_DIR"]) {
      expect(refused({ variables: { [name]: { description: "x" } } })).toThrow(`is set by the deployment itself`);
    }
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
    const written = { packages: { gh: "2" }, variables: { GITHUB_TOKEN: { description: "gh's token" } } };
    const file = parseContextFile(JSON.stringify({ content: {}, environment: written }), path);
    expect(file.environment).toEqual({ ...written, aptPackages: [] });
    expect(JSON.parse(contextFileText(file))).toEqual({ content: {}, environment: written });
    expect(
      JSON.parse(contextFileText({ content: {}, environment: { packages: {}, aptPackages: [], variables: {} } })),
    ).toEqual({ content: {} });
    // The two edits keep each other's part of the file.
    const dir = await agentDir();
    await writeEnvironment(dir, { packages: { gh: "2" }, aptPackages: ["chromium"], variables: {} });
    await addContent(dir, { name: "app", entry: { github: "acme/app" } });
    await writeEnvironment(dir, { packages: { jq: "latest" }, aptPackages: [], variables: {} });
    expect(JSON.parse(await readFile(join(dir, "context.json"), "utf8"))).toEqual({
      content: { app: { github: "acme/app" } },
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

  it("compares packages whatever their order, and reads `fastagent env add` arguments", () => {
    expect(samePackages({ a: "1", b: "2" }, { b: "2", a: "1" })).toBe(true);
    expect(samePackages({ a: "1" }, { a: "2" })).toBe(false);
    expect(samePackages({ a: "1" }, { a: "1", b: "2" })).toBe(false);
    expect(samePackages({}, { toString: "1" })).toBe(false);
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
    // A Debian-based image without dpkg cannot tell either: nothing is said, and nothing fails.
    process.env.PATH = await realpath(await mkdtemp(join(tmpdir(), "fa-env-no-dpkg-")));
    expect(missingAptPackages(["chromium"], true)).toBeUndefined();
    expect(aptAdvice(["chromium"])).toBe(
      "the image installs apt packages this machine does not have: chromium — `sudo apt-get install -y chromium`",
    );
  });
});

describe("environment: environment/, the image's lock", () => {
  it("is locked in a copy of its own after an install in another, and replaced only when it changed", async () => {
    const dir = await agentDir({ packages: { gh: "2", "npm:prettier": "3" } });
    const { bin, calls } = await fakeMise(dir);
    expect(await lockEnvironment(dir, { gh: "2", "npm:prettier": "3" }, async () => bin)).toBe(true);
    expect(await readFile(join(dir, "environment", "mise.toml"), "utf8")).toBe(
      `# Rendered by FastAgent from the "environment" of context.json: change that (fastagent env), not this file.\n` +
        `[settings.python]\ncompile = false\n\n[settings.ruby]\ncompile = false\n\n[settings.node]\ncompile = false\n\n` +
        `[settings.erlang]\ncompile = false\n\n[tools]\ngh = "2"\n"npm:prettier" = "3"\n`,
    );
    // The install's copy adds this machine's platform to the lock it reads; the published lock never has it.
    expect(await contents(join(dir, "environment"))).toEqual({
      "mise.toml": expect.any(String),
      "mise.lock": `[[tools."gh"]]\nversion = "2.83.1"\n[[tools."npm:prettier"]]\nversion = "2.83.1"\n`,
      ".mise/locks/npm-prettier/3.6.2/package.json": "{}\n",
    });
    const [install, lock] = await calls();
    expect([install?.args, lock?.args]).toEqual(["install", `lock ${PLATFORMS}`]);
    for (const call of [install, lock] as MiseCall[]) {
      // Each in a directory of its own outside the agent's, on that directory's configuration alone, since removed.
      expect(call.cwd.startsWith(dir)).toBe(false);
      expect(call.trusted).toBe(join(call.cwd, "mise.toml"));
      expect(call.ceiling).toBe(dirname(call.cwd));
      await expect(stat(call.cwd)).rejects.toThrow(/ENOENT/);
    }
    expect(install?.cwd).not.toBe(lock?.cwd);
    // Locking what is locked keeps every version: nothing to replace.
    const before = await contents(join(dir, "environment"));
    expect(await lockEnvironment(dir, { gh: "2", "npm:prettier": "3" }, async () => bin)).toBe(false);
    expect((await calls()).slice(2).map((call) => [call.args, call.lock])).toEqual([
      ["install", "locked"],
      [`lock ${PLATFORMS}`, "locked"],
    ]);
    expect(await contents(join(dir, "environment"))).toEqual(before);
  });

  it("is changed by one caller at a time, a deploy's included, and re-entered by the caller that holds it", async () => {
    const dir = await agentDir({ packages: { gh: "2" } });
    const { bin, calls } = await fakeMise(dir);
    const info = vi.spyOn(log, "info").mockImplementation(() => {});
    process.env.FAKE_SLOW = "1";
    // Two call chains of their own, as `fastagent env add` and `deploy` are: the second waits out the first's install.
    await Promise.all([
      lockEnvironment(dir, { gh: "2" }, async () => bin),
      lockEnvironment(dir, { gh: "2", jq: "1" }, async () => bin),
    ]);
    delete process.env.FAKE_SLOW;
    expect((await calls()).map((call) => call.args)).toEqual([
      "install",
      `lock ${PLATFORMS}`,
      "install",
      `lock ${PLATFORMS}`,
    ]);
    expect(info).toHaveBeenCalledWith("[fastagent] waiting for another change to this agent's environment to finish");
    // `fastagent env` holds it across its read and write of the declaration, and locks inside it.
    await withEnvironmentLock(dir, () => lockEnvironment(dir, { gh: "2", jq: "1" }, async () => bin));
    await expect(stat(join(dir, "environment.lock"))).rejects.toThrow(/ENOENT/);
  }, 30_000);

  it("resolves named packages again only when asked, and installs what moved", async () => {
    const dir = await agentDir({ packages: { gh: "latest" } });
    const { bin, calls } = await fakeMise(dir);
    await lockEnvironment(dir, { gh: "latest" }, async () => bin);
    expect(lockedVersions(dir).get("gh")).toBe("2.83.1");
    expect(await lockEnvironment(dir, { gh: "latest" }, async () => bin, ["gh"])).toBe(true);
    expect(lockedVersions(dir).get("gh")).toBe("2.90.0");
    expect((await calls()).slice(2).map((call) => call.args)).toEqual([
      "install",
      `lock --bump gh ${PLATFORMS}`,
      `lock ${PLATFORMS}`,
      "install",
    ]);
  });

  it("is left as it was by a failure; without packages, only FastAgent's files go", async () => {
    const dir = await agentDir({ packages: { gh: "2" } });
    const { bin } = await fakeMise(dir);
    await lockEnvironment(dir, { gh: "2" }, async () => bin);
    const before = await contents(join(dir, "environment"));
    process.env.FAKE_FAIL_INSTALL = "1";
    await expect(lockEnvironment(dir, { gh: "2", jq: "99" }, async () => bin)).rejects.toThrow(
      "mise install failed (exit 1)",
    );
    delete process.env.FAKE_FAIL_INSTALL;
    expect(await contents(join(dir, "environment"))).toEqual(before);
    await writeFile(join(dir, "environment", "notes.md"), "mine\n");
    expect(await removeEnvironment(dir)).toBe(true);
    expect(await readdir(join(dir, "environment"))).toEqual(["notes.md"]);
    expect(await removeEnvironment(dir)).toBe(false);
    await rm(join(dir, "environment", "notes.md"));
    await lockEnvironment(dir, { gh: "2" }, async () => bin);
    expect(await removeEnvironment(dir)).toBe(true);
    await expect(stat(join(dir, "environment"))).rejects.toThrow(/ENOENT/);
  });

  it("is FastAgent's only by its rendered configuration: an author's environment/ is never read, written or removed", async () => {
    const notes = async (dir: string) => {
      await mkdir(join(dir, "environment"), { recursive: true });
      await writeFile(join(dir, "environment", "notes.md"), "mine\n");
      await writeFile(join(dir, "environment", "mise.lock"), "not a lock FastAgent wrote\n");
    };
    const quiet = await agentDir({ aptPackages: ["chromium"] });
    await notes(quiet);
    expect(await removeEnvironment(quiet)).toBe(false);
    expect(await readdir(join(quiet, "environment"))).toEqual(["mise.lock", "notes.md"]);
    const dir = await agentDir({ packages: { gh: "2" } });
    await notes(dir);
    const { bin, calls } = await fakeMise(dir);
    // Refused before the agent's mise is asked for, which can add it to package.json.
    const mise = vi.fn(async () => bin);
    await expect(lockEnvironment(dir, { gh: "2" }, mise)).rejects.toThrow(
      `${join(dir, "environment")} was not written by FastAgent (it holds no mise.toml rendered from context.json)`,
    );
    expect(mise).not.toHaveBeenCalled();
    expect(lockedVersions(dir)).toEqual(new Map());
    // A process that runs the agent installs without it: its lock is not FastAgent's to follow.
    await enterEnvironment(dir);
    expect((await calls()).map((call) => [call.args, call.lock])).toEqual([
      ["install", "unlocked"],
      ["env --json", "unlocked"],
    ]);
    expect(await readdir(join(dir, "environment"))).toEqual(["mise.lock", "notes.md"]);
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

describe("environment: entered by a process that runs the agent", () => {
  it("installs from a copy of the lock and puts the packages on PATH, writing nothing in the agent directory", async () => {
    const dir = await agentDir({ packages: { gh: "2" } });
    await locked(dir, { gh: "2" });
    // The declaration ahead of its lock is no reason to refuse: the copy installs what the lock does not cover.
    await writeFile(join(dir, "context.json"), JSON.stringify({ environment: { packages: { gh: "2", jq: "1" } } }));
    const before = await contents(join(dir, "environment"));
    const { calls } = await fakeMise(dir);
    await enterEnvironment(dir);
    const runs = await calls();
    expect(runs.map((call) => [call.args, call.lock])).toEqual([
      ["install", "locked"],
      ["env --json", "locked"],
    ]);
    expect(runs[0]?.cwd.startsWith(dir)).toBe(false);
    await expect(stat(runs[0]?.cwd as string)).rejects.toThrow(/ENOENT/);
    expect(await contents(join(dir, "environment"))).toEqual(before);
    expect((process.env.PATH ?? "").split(delimiter)[0]).toBe("/fake/tools");
    expect(process.env.FAKE_TOOL_HOME).toBe("/fake/home");
    // The isolation is these runs' alone, and the agent's mise is not on the PATH.
    for (const name of ["MISE_TRUSTED_CONFIG_PATHS", "MISE_CEILING_PATHS", "MISE_OVERRIDE_CONFIG_FILENAMES"]) {
      expect(process.env[name], name).toBe(savedEnv[name]);
    }
    expect(process.env.PATH).not.toContain(join(dir, "node_modules"));
  });

  it("an agent without packages borrows the machine's commands; one with packages and no mise is refused", async () => {
    const before = process.env.PATH;
    await enterEnvironment(await agentDir({ aptPackages: ["chromium"] }));
    expect(process.env.PATH).toBe(before);
    const dir = await agentDir({ packages: { gh: "2" } });
    expect(miseBinary(dir)).toBeUndefined();
    await expect(enterEnvironment(dir)).rejects.toThrow(
      `context.json declares packages, and the agent has no mise installed — run \`fastagent env install\` in ${dir}`,
    );
  });

  it("requires the variables context.json declares before the agent runs, naming the file", async () => {
    const dir = await agentDir({ variables: { FA_TEST_HOST: { description: "the GitHub host gh talks to" } } });
    await expect(resolveAgentAssembly(dir)).rejects.toThrow(/missing required secrets: FA_TEST_HOST \(context\.json\)/);
    process.env.FA_TEST_HOST = "github.example.com";
    await resolveAgentAssembly(dir);
  });

  it("is entered by the assembly, so every process that opens the agent has it: createAgentService and chat too", async () => {
    await expect(resolveAgentAssembly(await agentDir({ packages: { gh: "2" } }))).rejects.toThrow(
      /the agent has no mise installed/,
    );
    const dir = await agentDir({ packages: { gh: "2" } });
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
    const { calls, log } = await fakeMise(dir);
    const add = await cli(["env", "add", "gh@2", "npm:prettier@3"], dir);
    expect(add.code, add.stderr).toBe(0);
    expect(await declared(dir)).toEqual({ packages: { gh: "2", "npm:prettier": "3" } });
    // At lock time the declaration was not written yet.
    expect(await log()).toContain(`context.json at lock: {"content":{}}`);
    expect(await readdir(join(dir, "environment"))).toEqual([".mise", "mise.lock", "mise.toml"]);
    const before = (await calls()).length;
    const apt = await cli(["env", "add", "apt:chromium"], dir);
    expect(apt.code, apt.stderr).toBe(0);
    expect(await declared(dir)).toEqual({ packages: { gh: "2", "npm:prettier": "3" }, aptPackages: ["chromium"] });
    expect((await calls()).length).toBe(before);
  });

  it("keeps the variables when it changes the packages", async () => {
    const variables = { FA_TEST_HOST: { description: "the GitHub host gh talks to" } };
    const dir = await agentDir({ variables });
    await fakeMise(dir);
    expect((await cli(["env", "add", "gh@2", "apt:chromium"], dir)).code).toBe(0);
    expect((await cli(["env", "remove", "apt:chromium"], dir)).code).toBe(0);
    expect(await declared(dir)).toEqual({ packages: { gh: "2" }, variables });
  });

  it("lists the variables context.json declares, and whether each has a value here, never the value", async () => {
    const dir = await agentDir({
      variables: { FA_TEST_HOST: { description: "the GitHub host" }, FA_TEST_TOKEN: { description: "gh's token" } },
    });
    await mkdir(join(dir, ".secrets"));
    await writeFile(join(dir, ".secrets", ".env"), "FA_TEST_TOKEN=ghp_value\n");
    const list = await cli(["env", "list"], dir);
    expect(list.code, list.stderr).toBe(0);
    expect(list.stdout).toBe(
      ["FA_TEST_HOST   not set   the GitHub host", "FA_TEST_TOKEN  set       gh's token", ""].join("\n"),
    );
    expect(list.stderr).toContain(
      `no value here for FA_TEST_HOST: dev and start refuse to run until they have one — set them in ` +
        `${join(dir, ".secrets", ".env")}`,
    );
    expect(`${list.stdout}${list.stderr}`).not.toContain("ghp_value");
  });

  it("refuses to edit a context.json whose content is refused, before anything is locked", async () => {
    const dir = await agentDir();
    await writeFile(join(dir, "context.json"), `{ "content": { "a": { "ref": "x" } } }`);
    const { calls } = await fakeMise(dir);
    const add = await cli(["env", "add", "gh@2"], dir);
    expect(add.code).toBe(1);
    expect(add.stderr).toContain(`content "a" needs "github"`);
    expect(await calls()).toEqual([]);
  });

  it("refuses a package FastAgent does not install from, and one mise cannot install, changing nothing", async () => {
    const dir = await agentDir({ packages: { gh: "2" } });
    await locked(dir, { gh: "2" });
    await fakeMise(dir);
    const before = await contents(join(dir, "environment"));
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
    expect(await contents(join(dir, "environment"))).toEqual(before);
  });

  it("leaves environment/ and context.json as they were when interrupted mid-install", async () => {
    const dir = await agentDir({ aptPackages: ["chromium"] });
    const { calls } = await fakeMise(dir);
    const child = spawn(process.execPath, [CLI, "env", "add", "gh@2"], {
      cwd: dir,
      env: { ...process.env, FAKE_SLOW: "1" },
    });
    const exited = new Promise((resolve) => child.on("close", resolve));
    while (!(await calls()).some((call) => call.args === "install")) await new Promise((r) => setTimeout(r, 50));
    child.kill("SIGINT");
    await exited;
    await expect(stat(join(dir, "environment"))).rejects.toThrow(/ENOENT/);
    expect(await declared(dir)).toEqual({ aptPackages: ["chromium"] });
  }, 30_000);

  it("removes packages, FastAgent's files in environment/ with the last one; a package it does not have is named", async () => {
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

  it("install locks what context.json changed by hand, says so, and installs here; again, it changes nothing", async () => {
    const dir = await agentDir({ packages: { gh: "2" } });
    await locked(dir, { gh: "2" });
    await writeFile(join(dir, "context.json"), JSON.stringify({ environment: { packages: { gh: "2", jq: "1" } } }));
    const { calls } = await fakeMise(dir);
    const install = await cli(["env", "install"], dir);
    expect(install.code, install.stderr).toBe(0);
    expect(install.stderr).toContain("environment/ is locked again from context.json — commit it");
    expect(lockedVersions(dir).get("jq")).toBe("2.83.1");
    // The packages are checked in parallel, so their `tool` runs are in no particular order.
    const args = (await calls()).map((call) => call.args);
    expect(args.slice(0, 2).sort()).toEqual(["tool gh --json", "tool jq --json"]);
    expect(args.slice(2)).toEqual(["install", `lock ${PLATFORMS}`, "install", "env --json"]);
    const again = await cli(["env", "install"], dir);
    expect(again.code, again.stderr).toBe(0);
    expect(again.stderr).not.toContain("locked again");
  });

  it("updates a locked version only when asked: the declaration stays, the lock moves, and says so", async () => {
    const dir = await agentDir({ packages: { gh: "latest" }, aptPackages: ["chromium"] });
    await locked(dir, { gh: "latest" });
    const { calls } = await fakeMise(dir);
    const update = await cli(["env", "update", "gh"], dir);
    expect(update.code, update.stderr).toBe(0);
    expect(update.stdout).toBe("gh  2.83.1 → 2.90.0\n");
    expect(update.stderr).toContain("commit environment/; a running `fastagent dev` restarts on it");
    expect((await calls()).map((call) => call.args)).toEqual([
      "tool gh --json",
      "install",
      `lock --bump gh ${PLATFORMS}`,
      `lock ${PLATFORMS}`,
      "install",
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
    await locked(dir, { gh: "2" });
    await fakeMise(dir);
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
    expect(list.stderr).toMatch(/package "tokei" resolves to cargo:tokei/);
    expect(list.stderr).toMatch(/pypi:markitdown installs with python and uv/);
  });

  it("runs a command in the environment, and exits as it does", async () => {
    const dir = await agentDir({ packages: { gh: "2" } });
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

  it("runs one at a time, so a second change starts from the first", async () => {
    const dir = await agentDir();
    const { calls } = await fakeMise(dir);
    const first = cli(["env", "add", "gh@2"], dir, { FAKE_SLOW: "1" });
    while (!(await calls()).some((call) => call.args === "install")) await new Promise((r) => setTimeout(r, 50));
    const second = await cli(["env", "add", "jq@1"], dir);
    expect((await first).code).toBe(0);
    expect(second.code, second.stderr).toBe(0);
    expect(second.stderr).toContain("waiting for another change to this agent's environment to finish");
    expect(await declared(dir)).toEqual({ packages: { gh: "2", jq: "1" } });
    await expect(stat(join(dir, "environment.lock"))).rejects.toThrow(/ENOENT/);
  }, 30_000);
});
