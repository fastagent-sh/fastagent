/**
 * RUNNING an agent's environment with mise. The agent carries its own mise, as optional npm dependencies, one package
 * per platform of which npm installs only this machine's: the author installs nothing, and the image's `npm ci`
 * installs the same mise. Every run reads only `environment/mise.toml`, the configuration FastAgent renders from the
 * declaration: never the machine's mise configuration, an author's own `mise.toml` or a parent directory's. Only the
 * commands an author runs write `environment/`; a process that runs the agent installs what its lock records.
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
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse, stringify } from "smol-toml";
import { writeFileAtomic } from "../atomic-write.ts";
import { loadEnvironment } from "../content/file.ts";
import { log } from "../log.ts";
import { detectRuntime, listsFastagent, readPackageJson } from "../runtime.ts";
import { aptAdvice, missingAptPackages } from "./apt.ts";
import {
  ENVIRONMENT_DIGEST_FILE,
  ENVIRONMENT_DIR,
  type MissingRuntime,
  missingPythonRuntime,
  packagesDigest,
  resolvedBackendRefusal,
  writtenBackend,
} from "./declare.ts";

/** In `environment/`: the configuration FastAgent renders, and the lock mise writes beside it. */
const MISE_FILE = "mise.toml";
const MISE_LOCK_FILE = "mise.lock";

/** mise's npm package for each platform it publishes one for, by Node's `${platform}-${arch}`. */
const MISE_PACKAGES: Readonly<Record<string, string>> = {
  "darwin-arm64": "@jdxcode/mise-darwin-arm64",
  "darwin-x64": "@jdxcode/mise-darwin-x64",
  "linux-arm64": "@jdxcode/mise-linux-arm64",
  "linux-x64": "@jdxcode/mise-linux-x64",
};

/** Every platform's package: an agent lists them all, so its lockfile has the image's too. */
export const MISE_PACKAGE_NAMES: readonly string[] = Object.values(MISE_PACKAGES);

/**
 * The platforms the lock records: an image is built for a linux one, and an author's machine is any. A process that
 * runs the agent installs with `--locked`, which refuses a platform the lock does not record rather than adding it.
 */
const LOCK_PLATFORMS = ["linux-x64", "linux-arm64", "macos-x64", "macos-arm64"] as const;

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
 * What every mise run for the agent at `realDir` (a path no link leads through) is given: only `environment/mise.toml`
 * is read, and it is trusted, as running the agent already trusts its code. The same values go into the image. They
 * are given to these runs alone, never exported to the agent's processes: a mise the agent runs is the machine's.
 */
export function isolationAt(realDir: string): Record<string, string> {
  return {
    // The file, not the directory: mise trusts by prefix.
    MISE_TRUSTED_CONFIG_PATHS: join(realDir, ENVIRONMENT_DIR, MISE_FILE),
    // mise does not read the ceiling directory itself, so an author's own mise.toml beside context.json is not read.
    MISE_CEILING_PATHS: realDir,
    MISE_GLOBAL_CONFIG_FILE: NO_FILE,
    MISE_SYSTEM_CONFIG_FILE: NO_FILE,
    MISE_OVERRIDE_CONFIG_FILENAMES: MISE_FILE,
    MISE_OVERRIDE_TOOL_VERSIONS_FILENAMES: "none",
  };
}

/**
 * Run the agent's mise with `args`, in `environment/` unless `cwd` says otherwise. Its progress and errors go to this
 * process's stderr; `capture` returns its stdout instead of passing it through, and `quiet` keeps its stderr for the
 * error, which then says what mise said.
 */
function runMise(
  agentDir: string,
  bin: string,
  args: readonly string[],
  options: { capture?: boolean; quiet?: boolean; cwd?: string } = {},
): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(bin, args, {
      cwd: options.cwd ?? join(agentDir, ENVIRONMENT_DIR),
      env: { ...process.env, ...isolationAt(realpathSync(agentDir)) },
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
      const out = await runMise(agentDir, bin, ["tool", name, "--json"], { capture: true, quiet: true, cwd: agentDir });
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
 * that name without it is the author's, and is never run, rewritten or removed.
 */
export const RENDERED_CONFIG_HEADER = `# Rendered by FastAgent from the "environment" of context.json: change that (fastagent env), not this file.\n`;

/** The files FastAgent writes in `environment/`: all it removes there. */
const RENDERED_ENTRIES = [MISE_FILE, MISE_LOCK_FILE, ENVIRONMENT_DIGEST_FILE, ".mise"] as const;

/**
 * The configuration rendered from `packages`. Prebuilt runtimes only: one with no build for a platform fails there
 * rather than compiling.
 */
function renderConfig(packages: Record<string, string>): string {
  return RENDERED_CONFIG_HEADER + stringify({ settings: { all_compile: false }, tools: packages });
}

/** Whether `environment/` is there, and whether FastAgent wrote it (its configuration starts with the header). */
function environmentDirState(agentDir: string): "absent" | "ours" | "foreign" {
  const dir = join(agentDir, ENVIRONMENT_DIR);
  if (!existsSync(dir)) return "absent";
  try {
    return readFileSync(join(dir, MISE_FILE), "utf8").startsWith(RENDERED_CONFIG_HEADER) ? "ours" : "foreign";
  } catch (error) {
    // ENOENT: a directory without FastAgent's configuration; ENOTDIR: a file of that name.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "foreign";
    throw error;
  }
}

/** The refusal for an `environment/` FastAgent did not write, where the lock of declared packages goes. */
function foreignEnvironment(agentDir: string): string {
  return (
    `${join(agentDir, ENVIRONMENT_DIR)} was not written by FastAgent (it holds no ${MISE_FILE} rendered from ` +
    `context.json), and it is where the lock of the packages context.json declares goes — move it out of the agent ` +
    `directory, then run \`fastagent env install\``
  );
}

/**
 * Run `change` on `environment/`, and put the directory back as it was when `change` fails: from a copy taken first,
 * or by removing what `change` created.
 */
async function restoredOnFailure(dir: string, change: () => Promise<void>): Promise<void> {
  const saved = existsSync(dir) ? mkdtempSync(join(tmpdir(), "fastagent-environment-")) : undefined;
  if (saved) cpSync(dir, saved, { recursive: true });
  try {
    await change();
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    if (saved) cpSync(saved, dir, { recursive: true });
    throw error;
  } finally {
    if (saved) rmSync(saved, { recursive: true, force: true });
  }
}

/**
 * Render `environment/` from `packages` and lock it: the configuration, then mise installs it here (which proves it
 * installs, and a PyPI package's lock needs uv installed), then locks it for every lock platform, keeping the version
 * the previous lock records for a package whose version is unchanged; the digest last. `commit` runs once it is
 * written, so the declaration lands after its lock. When either fails, `environment/` is put back as it was. Without
 * packages, FastAgent's files are removed from it, and the directory with them when nothing else is left. An
 * `environment/` FastAgent did not write is refused, never touched.
 */
export async function lockEnvironment(
  agentDir: string,
  packages: Record<string, string>,
  bin: string | undefined,
  commit?: () => Promise<void>,
): Promise<void> {
  const dir = join(agentDir, ENVIRONMENT_DIR);
  const state = environmentDirState(agentDir);
  const declares = Object.keys(packages).length > 0;
  if (state === "foreign" && declares) throw new Error(foreignEnvironment(agentDir));
  await restoredOnFailure(dir, async () => {
    if (!declares) {
      if (state === "ours") removeRendered(dir);
    } else {
      if (!bin) throw new Error("lockEnvironment: locking packages needs the agent's mise");
      mkdirSync(dir, { recursive: true });
      rmSync(join(dir, ENVIRONMENT_DIGEST_FILE), { force: true });
      writeFileAtomic(join(dir, MISE_FILE), renderConfig(packages));
      await runMise(agentDir, bin, ["install"]);
      await runMise(agentDir, bin, ["lock", "--platform", LOCK_PLATFORMS.join(",")]);
      writeFileAtomic(join(dir, ENVIRONMENT_DIGEST_FILE), `${packagesDigest(packages)}\n`);
    }
    await commit?.();
  });
}

/** Remove what FastAgent wrote in `dir`, and `dir` when that was all it held. */
function removeRendered(dir: string): void {
  for (const entry of RENDERED_ENTRIES) rmSync(join(dir, entry), { recursive: true, force: true });
  if (readdirSync(dir).length === 0) rmdirSync(dir);
}

/**
 * Resolve `names` (every package when empty) again to the newest version each one's declared version allows, in the
 * lock FastAgent wrote for the declaration (the caller makes sure it is), then install that here. The declaration and
 * its digest do not change: a version is resolved once, when a package is added, and stays locked until this.
 */
export async function updateEnvironment(agentDir: string, bin: string, names: readonly string[]): Promise<void> {
  await restoredOnFailure(join(agentDir, ENVIRONMENT_DIR), async () => {
    // What is locked now, first: a PyPI package's lock needs its uv installed.
    await runMise(agentDir, bin, ["--locked", "install"]);
    await runMise(agentDir, bin, ["lock", "--bump", ...names, "--platform", LOCK_PLATFORMS.join(",")]);
    await runMise(agentDir, bin, ["--locked", "install"]);
  });
}

/**
 * Why `environment/` cannot be run for `packages`, or undefined when it can: it records the digest of the packages it
 * was rendered from, and the declaration is what it is compared with, never the rendered text, so a lock another
 * FastAgent version rendered still runs. An `environment/` FastAgent did not write is the author's: ignored when no
 * package is declared, refused when one is.
 */
export function environmentMismatch(agentDir: string, packages: Record<string, string>): string | undefined {
  const dir = join(agentDir, ENVIRONMENT_DIR);
  const fix = `run \`fastagent env install\` in ${agentDir}, then commit ${ENVIRONMENT_DIR}/`;
  const state = environmentDirState(agentDir);
  if (Object.keys(packages).length === 0) {
    return state === "ours"
      ? `${ENVIRONMENT_DIR}/ is left from packages context.json no longer declares — ${fix}`
      : undefined;
  }
  if (state === "foreign") return foreignEnvironment(agentDir);
  let recorded: string;
  try {
    recorded = readFileSync(join(dir, ENVIRONMENT_DIGEST_FILE), "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return `context.json declares packages, and ${ENVIRONMENT_DIR}/ has no lock for them — ${fix}`;
  }
  if (recorded !== packagesDigest(packages)) {
    return `the packages context.json declares are not the ones ${ENVIRONMENT_DIR}/ was locked for — ${fix}`;
  }
  return undefined;
}

/** What a process that runs the agent says when its environment has no mise to install it with. */
function missingMise(agentDir: string): Error {
  return new Error(
    `context.json declares packages, and the agent has no mise installed — run \`fastagent env install\` in ${agentDir}`,
  );
}

/**
 * Enter the agent's environment, for a process that runs it: install the versions `environment/` locks, and put them on
 * this process's PATH, which every command the agent runs inherits. It writes nothing, so an `environment/` that is
 * not the declaration's lock is refused. mise itself is not put on the PATH. An agent without packages borrows the
 * machine's commands. Apt packages are the image's to install; one missing here is said, with how to install it.
 */
export async function enterEnvironment(agentDir: string): Promise<void> {
  const declared = loadEnvironment(agentDir);
  const missingApt = missingAptPackages(declared?.aptPackages ?? []);
  if (missingApt && missingApt.length > 0) log.warn(`[fastagent] ${aptAdvice(missingApt)}`);
  const packages = declared?.packages ?? {};
  const stale = environmentMismatch(agentDir, packages);
  if (stale) throw new Error(stale);
  if (Object.keys(packages).length === 0) return;
  const bin = miseBinary(agentDir);
  if (!bin) throw missingMise(agentDir);
  await runMise(agentDir, bin, ["--locked", "install"]);
  const env = JSON.parse(await runMise(agentDir, bin, ["--locked", "env", "--json"], { capture: true })) as Record<
    string,
    string
  >;
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
