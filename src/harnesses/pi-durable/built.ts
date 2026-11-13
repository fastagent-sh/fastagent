/**
 * What `dist/` is, as a project and an opener both see it: which of the project's files go
 * into it, the fingerprint the build records of what it read, and the opener that refuses a `dist/` the project has
 * moved on from.
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { exists } from "../../paths.ts";
import { type AgentDefinition, assertDefinition } from "./definition.ts";
import { registryFiles } from "./registry.ts";

export const DIST_DIR = "dist";
/** Beside the package's entry: the format and fingerprint of the build, and the code files it read. */
export const BUILD_FILE = "build.json";

const CODE = /\.(ts|mts|cts|tsx|js|mjs|cjs|jsx)$/;
const TEST = /\.(test|spec)\.[a-z]+$/;
/** What never leaves the project, wherever it is: secrets, dependencies, history, the build's own output. */
const NEVER_COPIED = /^(\.env(\..*)?|\.secrets|node_modules|\.git|\.DS_Store)$/;
/** The program's text and data at the project root. */
const ROOT_FILES = ["SYSTEM.md", "AGENTS.md", "README.md"];
const ROOT_DIRS = ["skills", "prompts", "assets"];
const LICENSE = /^LICEN[CS]E(\..*)?$/i;

/** The build's record, in `dist/build.json`: no path of the machine that made it. */
interface BuildRecord {
  /** The code files (project-relative) the compiler read: the program, with what it imports. */
  code: string[];
  fingerprint: string;
}

/**
 * The files the build copies into `dist/` beside what it compiled, as project-relative `[from, to]`: the text and data
 * of the root, `skills/`, `prompts/` and `assets/` whole, and in each directory the code lives in, every file that is
 * not code or a test (a module's resource is relative to the module, so it lands beside it). A link is followed to
 * what it names, and one back into a directory being listed is refused.
 */
export async function copyPlan(dir: string, code: readonly string[]): Promise<string[]> {
  const files: string[] = [];
  for (const name of await readdir(dir)) {
    if (ROOT_FILES.includes(name) || LICENSE.test(name)) files.push(name);
  }
  for (const name of ROOT_DIRS) {
    if (await exists(join(dir, name))) files.push(...(await filesIn(dir, name, () => true)));
  }
  const compiledIn = new Set(code.filter((file) => file.includes("/")).map((file) => file.split("/")[0] as string));
  for (const name of [...compiledIn].filter((name) => !ROOT_DIRS.includes(name))) {
    files.push(...(await filesIn(dir, name, (file) => !CODE.test(file) && !TEST.test(file))));
  }
  return [...new Set(files)].sort();
}

async function filesIn(
  dir: string,
  rel: string,
  include: (name: string) => boolean,
  within: readonly string[] = [],
): Promise<string[]> {
  const here = await realpath(join(dir, rel));
  if (within.includes(here)) throw new Error(`${rel} links back to ${here}, a directory this build is copying`);
  const files: string[] = [];
  for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
    if (NEVER_COPIED.test(entry.name)) continue;
    const path = `${rel}/${entry.name}`;
    const target = await stat(join(dir, path));
    if (target.isDirectory()) files.push(...(await filesIn(dir, path, include, [...within, here])));
    else if (target.isFile() && include(entry.name)) files.push(path);
  }
  return files;
}

/** Copy each of `files`, project-relative, from `dir` to `to`. */
export async function copyFiles(dir: string, to: string, files: readonly string[]): Promise<void> {
  for (const file of files) {
    await mkdir(dirname(join(to, file)), { recursive: true });
    await copyFile(join(dir, file), join(to, file));
  }
}

async function digest(path: string): Promise<string> {
  try {
    return createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

/**
 * Everything the build reads from the project, as one hash: the code the compiler read, the modules the registry lists
 * now, the files it would copy, and `package.json`. Runtime writes (state, secrets, an agent's own output) are none of
 * these, so running an agent never makes its build stale.
 */
async function fingerprintOf(dir: string, code: readonly string[]): Promise<string> {
  const files = new Set([...code, ...(await registryFiles(dir)), ...(await copyPlan(dir, code)), "package.json"]);
  const hash = createHash("sha256");
  for (const file of [...files].sort()) hash.update(`${file}\0${await digest(join(dir, file))}\n`);
  return hash.digest("hex");
}

export async function buildRecord(dir: string, code: readonly string[]): Promise<string> {
  const record: BuildRecord = { code: [...code].sort(), fingerprint: await fingerprintOf(dir, code) };
  return `${JSON.stringify(record, null, 2)}\n`;
}

/** Why `dist/` of the project in `dir` cannot be opened, or nothing when it is the build of the project as it is. */
async function builtProblem(dir: string, checkSources: boolean): Promise<string | undefined> {
  const rebuild = "run `fastagent build`";
  const dist = join(dir, DIST_DIR);
  if (!(await exists(join(dist, BUILD_FILE)))) return `${dist} holds no build: ${rebuild}`;
  if (!checkSources) return undefined;
  const record = JSON.parse(await readFile(join(dist, BUILD_FILE), "utf8")) as BuildRecord;
  return (await fingerprintOf(dir, record.code)) === record.fingerprint
    ? undefined
    : `${dist} was built from other sources than ${dir} holds now: ${rebuild}`;
}

/**
 * The definition of the project's `dist/`: refused, naming `fastagent build`, when there is none or, with
 * `checkSources`, when the project has moved on from it. A deployed box's project is the release's copy, which the
 * agent works in and edits, so only a local `start` asks whether the author forgot to build.
 */
export async function loadProjectBuild(
  directory: string,
  { checkSources }: { checkSources: boolean },
): Promise<AgentDefinition> {
  const problem = await builtProblem(directory, checkSources);
  if (problem !== undefined) throw new Error(problem);
  return loadBuiltDefinition(join(directory, DIST_DIR));
}

/** The definition a built package (`dist/`, or one installed under `node_modules`) exports. */
export async function loadBuiltDefinition(dist: string): Promise<AgentDefinition> {
  const entry = join(dist, "index.js");
  if (!(await exists(entry))) throw new Error(`${dist} has no index.js: it is not a built agent package`);
  return assertDefinition(((await import(pathToFileURL(entry).href)) as { default?: unknown }).default);
}
