import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

/**
 * How to install and run an agent: its own `package.json` and lockfile decide.
 */
export interface AgentRuntime {
  /** The JS runtime the agent targets — drives generated Dockerfiles and package-manager hints. */
  readonly runtime: "node" | "bun";
  /** For `runtime: "bun"`, the version from `packageManager: "bun@x"` (undefined when detected by lockfile alone). */
  readonly bunVersion?: string;
  /** Whether the runtime's lockfile is present (`package-lock.json` for node, `bun.lock`/`bun.lockb` for bun). */
  readonly hasLockfile: boolean;
}

/**
 * Detect which JS runtime an agent targets: `bun` when `package.json`'s `packageManager` is `bun@…` or a bun lockfile
 * (`bun.lock`/`bun.lockb`) is present, else `node`.
 */
export function detectRuntime(dir: string, pkg: { readonly packageManager?: unknown } = {}): AgentRuntime {
  const pm = typeof pkg.packageManager === "string" ? pkg.packageManager : "";
  const bunLock = existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"));
  if (pm.startsWith("bun@") || bunLock) {
    // corepack pins as `bun@1.4.4+sha256.<hash>`; accept only a concrete semver Docker tag before `+`.
    const bunVersion = /^bun@(\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?)(?:\+|$)/.exec(pm)?.[1];
    return { runtime: "bun", ...(bunVersion === undefined ? {} : { bunVersion }), hasLockfile: bunLock };
  }
  return { runtime: "node", hasLockfile: existsSync(join(dir, "package-lock.json")) };
}

/** Whether the current process is running under Bun (`process.versions.bun` is set only there). */
export function isBunRuntime(versions: { readonly node: string; readonly bun?: string } = process.versions): boolean {
  return typeof versions.bun === "string";
}

function packageNameOf(specifier: string): string {
  return specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : (specifier.split("/")[0] ?? specifier);
}

function hasInstalledPackage(dir: string, pkgName: string): boolean {
  let cur = resolve(dir);
  while (true) {
    if (existsSync(join(cur, "node_modules", pkgName))) return true;
    const parent = dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

/**
 * Resolve a bare package `specifier` installed under `dir` (or an ancestor workspace), or `undefined` when absent.
 *
 * Under Bun, `createRequire().resolve()` falls back to Bun's global auto-install cache (`~/.bun/install/cache`) when
 * a package is missing from `node_modules`, which would silently fetch from npm or delegate to an unrelated cached
 * install. Pre-checking `node_modules` prevents auto-install while preserving `exports` map resolution.
 */
export function resolveFromProject(dir: string, specifier: string): string | undefined {
  if (isBunRuntime() && !hasInstalledPackage(dir, packageNameOf(specifier))) return undefined;
  try {
    return createRequire(join(dir, "package.json")).resolve(specifier);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND" || code === "ERR_PACKAGE_PATH_NOT_EXPORTED") {
      return undefined;
    }
    throw error;
  }
}

/**
 * The oldest runtimes that run an agent, both set by the instance's storage, `node:sqlite`: Node drops its
 * experimental warning from 24.15.0, and Bun 1.4.4 reliably releases `PRAGMA locking_mode = EXCLUSIVE` locks on
 * `DatabaseSync.close()` when statements were prepared (1.4.0 leaves the file locked until GC).
 */
export const RUNTIME_FLOOR = { node: "24.15.0", bun: "1.4.4" } as const;

/** Whether `version` (`1.3.13`, `24.4`) is older than `floor`; false for one that names no version (`canary`). */
export function belowFloor(version: string, floor: string): boolean {
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(version);
  if (match === null) return false;
  const given = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
  const least = floor.split(".").map(Number);
  const differs = given.findIndex((part, i) => part !== least[i]);
  return differs !== -1 && (given[differs] as number) < (least[differs] as number);
}

/** Why this process's runtime cannot run fastagent, or undefined when it can. Bun reports a Node version too. */
export function unsupportedRuntime(
  versions: { readonly node: string; readonly bun?: string } = process.versions,
): string | undefined {
  const [name, version, floor] =
    versions.bun === undefined ? ["Node", versions.node, RUNTIME_FLOOR.node] : ["Bun", versions.bun, RUNTIME_FLOOR.bun];
  return belowFloor(version, floor) ? `fastagent needs ${name} ${floor} or later; this is ${version}` : undefined;
}

/** Whether a manifest declares `name` in dependencies or devDependencies. */
export function listsPackage(
  pkg: {
    dependencies?: Record<string, unknown>;
    devDependencies?: Record<string, unknown>;
  },
  name: string,
): boolean {
  return name in { ...pkg.dependencies, ...pkg.devDependencies };
}

/**
 * Whether a manifest lists FastAgent, which the image of an agent with a `package.json` runs from its own
 * `node_modules`: without it, the container cannot start.
 */
export function listsFastagent(pkg: {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
}): boolean {
  return listsPackage(pkg, "@fastagent-sh/fastagent");
}

/**
 * Parse `<dir>/package.json`, or `{}` when there is none (a markdown-only agent). A file that does not parse throws,
 * naming itself: read as `{}` it became "does not list @fastagent-sh/fastagent" and an npm-based image, both wrong.
 */
export async function readPackageJson(dir: string): Promise<{
  packageManager?: unknown;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
}> {
  const path = join(dir, "package.json");
  const raw = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (raw === undefined) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }
}
