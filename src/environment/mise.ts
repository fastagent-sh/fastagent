/**
 * RUNNING an agent's environment with mise. The agent carries its own mise, as optional npm dependencies, one package
 * per platform of which npm installs only this machine's: the author installs nothing, and the image's `npm ci`
 * installs the same mise. mise only ever reads a configuration FastAgent renders from the declaration, never the
 * machine's mise configuration, an author's own `mise.toml` or a parent directory's.
 *
 * `environment/` is the image's lock, committed: only the commands an author runs (`fastagent env`, `deploy`) write it,
 * and they replace it once a new lock is complete. A process that runs the agent installs from a copy of it, so it
 * follows the locked versions, resolves a package the lock does not cover yet, and writes nothing that is committed.
 */
import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parse, stringify } from "smol-toml";
import { writeFileAtomic } from "../atomic-write.ts";
import { loadEnvironment } from "../content/file.ts";
import { log } from "../log.ts";
import { detectRuntime, listsFastagent, readPackageJson } from "../runtime.ts";
import { aptAdvice, missingAptPackages } from "./apt.ts";
import {
  ENVIRONMENT_DIR,
  type MissingRuntime,
  missingPythonRuntime,
  resolvedBackendRefusal,
  writtenBackend,
} from "./declare.ts";

/** In `environment/`: the configuration FastAgent renders, and the lock mise writes beside it. */
const MISE_FILE = "mise.toml";
const MISE_LOCK_FILE = "mise.lock";

/** The committed lock, relative to the agent directory: what a `dev` worker restarts on. */
export const ENVIRONMENT_LOCK = join(ENVIRONMENT_DIR, MISE_LOCK_FILE);

/** mise's npm package for each platform it publishes one for, by Node's `${platform}-${arch}`. */
const MISE_PACKAGES: Readonly<Record<string, string>> = {
  "darwin-arm64": "@jdxcode/mise-darwin-arm64",
  "darwin-x64": "@jdxcode/mise-darwin-x64",
  "linux-arm64": "@jdxcode/mise-linux-arm64",
  "linux-x64": "@jdxcode/mise-linux-x64",
};

/** Every platform's package: an agent lists them all, so its lockfile has the image's too. */
export const MISE_PACKAGE_NAMES: readonly string[] = Object.values(MISE_PACKAGES);

/** The platforms the lock records: the ones an image is built for. */
const LOCK_PLATFORMS = ["linux-x64", "linux-arm64"].join(",");

/** A path no file can be at, for the mise configuration files an agent's environment must not read. */
const NO_FILE = "/dev/null/none.toml";

/** This machine's mise package; a platform mise publishes none for cannot run an environment. */
function platformPackage(): string {
  const key = `${process.platform}-${process.arch}`;
  const name = MISE_PACKAGES[key];
  if (!name) throw new Error(`an agent's environment does not run on ${key} yet: mise has no npm package for it`);
  return name;
}

/**
 * The agent's mise on this machine, or undefined when the agent has none installed. Found by its package, not by
 * `node_modules/.bin/mise`: the platform packages all name that bin, and npm drops the link while it skips the
 * other platforms' packages.
 */
export function miseBinary(agentDir: string): string | undefined {
  const require = createRequire(join(resolve(agentDir), "package.json"));
  try {
    return join(dirname(require.resolve(`${platformPackage()}/package.json`)), "bin", "mise");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND") return undefined;
    throw error;
  }
}

/**
 * What every mise run on the configuration in `configDir` (a path no link leads through) is given: only that file is
 * read, and it is trusted, as running the agent already trusts its code. The same values go into the image. They are
 * given to these runs alone, never exported to the agent's processes: a mise the agent runs is the machine's.
 */
export function isolationAt(configDir: string): Record<string, string> {
  return {
    // The file, not the directory: mise trusts by prefix.
    MISE_TRUSTED_CONFIG_PATHS: join(configDir, MISE_FILE),
    // mise does not read the ceiling directory itself: in the agent directory, an author's own mise.toml.
    MISE_CEILING_PATHS: dirname(configDir),
    MISE_GLOBAL_CONFIG_FILE: NO_FILE,
    MISE_SYSTEM_CONFIG_FILE: NO_FILE,
    MISE_OVERRIDE_CONFIG_FILENAMES: MISE_FILE,
    MISE_OVERRIDE_TOOL_VERSIONS_FILENAMES: "none",
  };
}

/**
 * Run the agent's mise with `args` on the configuration in `configDir`, from there unless `cwd` says otherwise. Its
 * progress and errors go to this process's stderr; `capture` returns its stdout instead of passing it through, and
 * `quiet` keeps its stderr for the error, which then says what mise said.
 */
function runMise(
  configDir: string,
  bin: string,
  args: readonly string[],
  options: { capture?: boolean; quiet?: boolean; cwd?: string } = {},
): Promise<string> {
  const realConfigDir = join(realpathSync(dirname(configDir)), basename(configDir));
  return new Promise((done, fail) => {
    const child = spawn(bin, args, {
      cwd: options.cwd ?? configDir,
      env: { ...process.env, ...isolationAt(realConfigDir) },
      stdio: ["inherit", options.capture ? "pipe" : process.stderr, options.quiet ? "pipe" : "inherit"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", fail);
    child.on("close", (code, signal) => {
      if (code === 0) return done(stdout);
      const said = stderr.match(/ERROR\s+(.+)/)?.[1];
      fail(new Error(`mise ${args.join(" ")} failed (${signal ?? `exit ${code}`})${said ? `: ${said}` : ""}`));
    });
  });
}

/**
 * The command that puts mise into the agent: every platform's package, at the newest version, pinned. When
 * `package.json` already lists it (a fresh clone), the dependencies are installed as they are, never upgraded.
 */
async function addMiseCommand(agentDir: string): Promise<[string, string[]]> {
  const pkg = await readPackageJson(agentDir);
  const { runtime } = detectRuntime(agentDir, pkg);
  if (platformPackage() in (pkg.optionalDependencies ?? {})) {
    return runtime === "bun" ? ["bun", ["install"]] : ["npm", ["install", "--no-audit", "--no-fund"]];
  }
  const packages = MISE_PACKAGE_NAMES.map((name) => `${name}@latest`);
  return runtime === "bun"
    ? ["bun", ["add", "--optional", "--exact", ...packages]]
    : ["npm", ["install", "--save-optional", "--save-exact", "--no-audit", "--no-fund", ...packages]];
}

/**
 * The agent's mise, added to its `package.json` first when it has none: for the commands an author runs to change the
 * environment (`fastagent env`), never for one that runs the agent. A manifest that does not list FastAgent is
 * refused: the mise would make it a code agent, whose image runs the FastAgent its `package.json` lists.
 */
export async function ensureMise(agentDir: string): Promise<string> {
  const found = miseBinary(agentDir);
  if (found) return found;
  if (!listsFastagent(await readPackageJson(agentDir))) {
    throw new Error(
      `${join(agentDir, "package.json")} does not list @fastagent-sh/fastagent — the agent's mise is one of its ` +
        `dependencies, and an agent with dependencies runs the FastAgent they list. Add it first: ` +
        `\`npm install @fastagent-sh/fastagent\` in ${agentDir}`,
    );
  }
  const [command, args] = await addMiseCommand(agentDir);
  log.info(`[fastagent] installing the agent's mise: ${command} ${args.join(" ")}`);
  await new Promise<void>((done, fail) => {
    const child = spawn(command, args, { cwd: agentDir, stdio: ["inherit", process.stderr, "inherit"] });
    child.on("error", fail);
    child.on("close", (code) => (code === 0 ? done() : fail(new Error(`${command} ${args[0]} failed (exit ${code})`))));
  });
  const added = miseBinary(agentDir);
  if (!added) throw new Error(`${command} ${args[0]} added mise to ${agentDir}, and it is still not installed`);
  return added;
}

/** What the packages need before they are locked: refusals, and a PyPI package's undeclared runtime. */
export interface PackageCheck {
  /** Registry names that resolve to a backend FastAgent leaves out. */
  refusals: string[];
  runtime?: MissingRuntime;
}

/**
 * Check `packages` against the backend each resolves to: a written one says it (`npm:prettier`), and mise resolves a
 * registry name (`tokei` is `cargo:tokei`). A name mise does not know fails the check with what mise said.
 */
export async function checkPackages(
  agentDir: string,
  bin: string,
  packages: Record<string, string>,
): Promise<PackageCheck> {
  const kinds = new Map<string, string>();
  const refusals: string[] = [];
  await Promise.all(
    Object.keys(packages).map(async (name) => {
      const written = writtenBackend(name);
      if (written) return void kinds.set(name, written);
      const out = await runMise(join(agentDir, ENVIRONMENT_DIR), bin, ["tool", name, "--json"], {
        capture: true,
        quiet: true,
        cwd: agentDir,
      });
      const backend = (JSON.parse(out) as { backend?: unknown }).backend;
      if (typeof backend !== "string") throw new Error(`mise tool ${name} --json reported no backend`);
      kinds.set(name, backend.split(":")[0] ?? backend);
      const refusal = resolvedBackendRefusal(name, backend);
      if (refusal) refusals.push(refusal);
    }),
  );
  const runtime = missingPythonRuntime(packages, kinds);
  return { refusals: refusals.sort(), ...(runtime ? { runtime } : {}) };
}

/**
 * The first line of every configuration FastAgent renders: what marks `environment/` as FastAgent's. A directory of
 * that name without it is the author's: never read, written or removed.
 */
const RENDERED_CONFIG_HEADER = `# Rendered by FastAgent from the "environment" of context.json: change that (fastagent env), not this file.\n`;

/** The files FastAgent writes in `environment/`: all it replaces or removes there. */
const RENDERED_ENTRIES = [MISE_FILE, MISE_LOCK_FILE, ".mise"] as const;

/**
 * The configuration rendered from `packages`. Prebuilt runtimes only: one with no build for a platform fails there
 * rather than compiling, which mise does for python by default (and `all_compile`, already false, does not stop).
 */
function renderConfig(packages: Record<string, string>): string {
  const prebuilt = { compile: false };
  return (
    RENDERED_CONFIG_HEADER +
    stringify({ settings: { python: prebuilt, ruby: prebuilt, node: prebuilt, erlang: prebuilt }, tools: packages })
  );
}

/**
 * Whether `environment/` holds anything, and whether FastAgent wrote it (its configuration starts with the header).
 * An empty directory holds nothing of anyone's.
 */
function environmentDirState(agentDir: string): "absent" | "ours" | "foreign" {
  const dir = join(agentDir, ENVIRONMENT_DIR);
  if (!existsSync(dir) || (statSync(dir).isDirectory() && readdirSync(dir).length === 0)) return "absent";
  try {
    return readFileSync(join(dir, MISE_FILE), "utf8").startsWith(RENDERED_CONFIG_HEADER) ? "ours" : "foreign";
  } catch (error) {
    // ENOENT: a directory without FastAgent's configuration; ENOTDIR: a file of that name.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "foreign";
    throw error;
  }
}

/**
 * A directory of its own, outside the agent's, holding the configuration rendered from `packages` and, when
 * `environment/` is FastAgent's, a copy of its lock: where every mise run that installs or locks happens, so nothing
 * there reaches `environment/` unless it is published. The caller removes it.
 */
function workingCopy(agentDir: string, packages: Record<string, string>): string {
  const work = mkdtempSync(join(tmpdir(), "fastagent-environment-"));
  const dir = join(agentDir, ENVIRONMENT_DIR);
  if (environmentDirState(agentDir) === "ours") {
    for (const entry of [MISE_LOCK_FILE, ".mise"]) {
      if (existsSync(join(dir, entry))) cpSync(join(dir, entry), join(work, entry), { recursive: true });
    }
  }
  writeFileAtomic(join(work, MISE_FILE), renderConfig(packages));
  return work;
}

/** Run `use` on a {@link workingCopy}, removed afterwards whatever happens. */
async function inWorkingCopy<T>(
  agentDir: string,
  packages: Record<string, string>,
  use: (work: string) => Promise<T>,
): Promise<T> {
  const work = workingCopy(agentDir, packages);
  try {
    return await use(work);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Install `packages` on this machine: the versions the lock records where it covers them, the newest the declared
 * version allows where it does not. Writes nothing in the agent directory.
 */
async function installHere(agentDir: string, packages: Record<string, string>, bin: string): Promise<void> {
  await inWorkingCopy(agentDir, packages, (work) => runMise(work, bin, ["install"]));
}

/**
 * Lock `packages` into `environment/`, for the platforms an image is built for, and say whether that changed it. They
 * are installed here first, in a copy of their own: that proves they install, and a PyPI package's lock needs its uv
 * installed. The lock is made in another copy, since an install adds this machine's platform to the lock it reads,
 * and keeps the version the lock records for a package whose declared version is unchanged; `bump` names packages to
 * resolve again to the newest their declared version allows (every one when empty). `environment/` is replaced only
 * once the lock is complete, so a failure or an interrupt leaves it as it was. Without packages, FastAgent's files
 * are removed from it, and the directory with them when nothing else is left. An `environment/` FastAgent did not
 * write is refused, never touched.
 */
export async function lockEnvironment(
  agentDir: string,
  packages: Record<string, string>,
  bin: string | undefined,
  bump?: readonly string[],
): Promise<boolean> {
  const dir = join(agentDir, ENVIRONMENT_DIR);
  const state = environmentDirState(agentDir);
  if (Object.keys(packages).length === 0) {
    if (state !== "ours") return false;
    removeRendered(dir);
    return true;
  }
  if (state === "foreign") throw new Error(foreignEnvironment(agentDir));
  if (!bin) throw new Error("lockEnvironment: locking packages needs the agent's mise");
  await installHere(agentDir, packages, bin);
  const changed = await inWorkingCopy(agentDir, packages, async (work) => {
    if (bump) await runMise(work, bin, ["lock", "--bump", ...bump, "--platform", LOCK_PLATFORMS]);
    await runMise(work, bin, ["lock", "--platform", LOCK_PLATFORMS]);
    return publish(work, dir);
  });
  // What was resolved again is installed here too, so `fastagent env update` proves it installs.
  if (bump && changed) await installHere(agentDir, packages, bin);
  return changed;
}

/** Replace FastAgent's files in `dir` with the working copy's, when they differ; whether they did. */
function publish(work: string, dir: string): boolean {
  if (existsSync(dir) && renderedContent(work) === renderedContent(dir)) return false;
  if (existsSync(dir)) for (const entry of RENDERED_ENTRIES) rmSync(join(dir, entry), { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const entry of RENDERED_ENTRIES) {
    if (existsSync(join(work, entry))) cpSync(join(work, entry), join(dir, entry), { recursive: true });
  }
  return true;
}

/** FastAgent's files in `dir`, as one comparable string: each path, then its content. */
function renderedContent(dir: string): string {
  const files = RENDERED_ENTRIES.flatMap((entry) => {
    const path = join(dir, entry);
    if (!existsSync(path)) return [];
    if (entry !== ".mise") return [entry];
    return readdirSync(path, { recursive: true, withFileTypes: true })
      .filter((found) => found.isFile())
      .map((found) => join(found.parentPath.slice(dir.length + 1), found.name));
  });
  return files
    .sort()
    .map((file) => `${file}\0${readFileSync(join(dir, file), "utf8")}`)
    .join("\0");
}

/** The refusal for an `environment/` FastAgent did not write, where the lock of declared packages goes. */
function foreignEnvironment(agentDir: string): string {
  return (
    `${join(agentDir, ENVIRONMENT_DIR)} was not written by FastAgent (it holds no ${MISE_FILE} rendered from ` +
    `context.json), and it is where the lock of the packages context.json declares goes — move it out of the agent ` +
    `directory`
  );
}

/** Remove what FastAgent wrote in `dir`, and `dir` when that was all it held. */
function removeRendered(dir: string): void {
  for (const entry of RENDERED_ENTRIES) rmSync(join(dir, entry), { recursive: true, force: true });
  if (readdirSync(dir).length === 0) rmdirSync(dir);
}

/** What a process that runs the agent says when its environment has no mise to install it with. */
function missingMise(agentDir: string): Error {
  return new Error(
    `context.json declares packages, and the agent has no mise installed — run \`fastagent env install\` in ${agentDir}`,
  );
}

/**
 * Enter the agent's environment, for a process that runs it: install the declared packages, at the versions the lock
 * records where it covers them, and put them first on this process's PATH, which every command the agent runs
 * inherits. It runs in a copy of the lock, so it never writes `environment/`, and never refuses one that lags the
 * declaration: `fastagent env` and `deploy` lock it. mise itself is not put on the PATH. An agent without packages
 * borrows the machine's commands. Apt packages are the image's to install; one missing here is said, with how.
 */
export async function enterEnvironment(agentDir: string): Promise<void> {
  const declared = loadEnvironment(agentDir);
  const missingApt = missingAptPackages(declared?.aptPackages ?? []);
  if (missingApt && missingApt.length > 0) log.warn(`[fastagent] ${aptAdvice(missingApt)}`);
  const packages = declared?.packages ?? {};
  if (Object.keys(packages).length === 0) return;
  const bin = miseBinary(agentDir);
  if (!bin) throw missingMise(agentDir);
  const env = await inWorkingCopy(agentDir, packages, async (work) => {
    await runMise(work, bin, ["install"]);
    // The PATH names the installs in mise's data (or system) directory, not the copy, which goes after this.
    return JSON.parse(await runMise(work, bin, ["env", "--json"], { capture: true })) as Record<string, string>;
  });
  Object.assign(process.env, env);
}

/** The version `environment/mise.lock` records for each package, for `fastagent env list`. */
export function lockedVersions(agentDir: string): Map<string, string> {
  let text: string;
  try {
    text = readFileSync(join(agentDir, ENVIRONMENT_DIR, MISE_LOCK_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
  const tools = (parse(text).tools ?? {}) as Record<string, { version?: unknown }[]>;
  return new Map(
    Object.entries(tools).flatMap(([name, entries]) => {
      const version = entries[0]?.version;
      return typeof version === "string" ? [[name, version] as [string, string]] : [];
    }),
  );
}
