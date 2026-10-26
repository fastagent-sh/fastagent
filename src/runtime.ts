import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * How to install and run the AGENT: its own package.json + lockfile decide.
 */
export interface AgentRuntime {
  /**
   * The JS runtime the agent targets — drives the generated Dockerfile base + install/run commands and the
   * package-manager hints in `init`/`add`.
   */
  runtime: "node" | "bun";
  /**
   * For `runtime: "bun"`, the version from package.json's `packageManager: "bun@x"` (undefined if a bun lockfile made
   * it bun but no version is pinned).
   */
  bunVersion?: string;
  /** Whether the runtime's lockfile is present (package-lock.json for node, bun.lock/bun.lockb for bun). */
  hasLockfile: boolean;
}

/**
 * Detect which JS runtime an agent targets: `bun` when package.json's `packageManager` is `bun@…` OR a bun lockfile
 * (bun.lock/bun.lockb) is present, else `node`.
 */
export function detectRuntime(dir: string, pkg: { packageManager?: unknown }): AgentRuntime {
  const pm = typeof pkg.packageManager === "string" ? pkg.packageManager : "";
  const bunLock = existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"));
  if (pm.startsWith("bun@") || bunLock) {
    // corepack pins as `bun@1.3.13+sha256.<hash>`; the version (a Docker tag for oven/bun) is the part BEFORE `+`.
    return { runtime: "bun", bunVersion: pm.match(/^bun@([^+]+)/)?.[1], hasLockfile: bunLock };
  }
  return { runtime: "node", hasLockfile: existsSync(join(dir, "package-lock.json")) };
}

/**
 * The oldest runtimes that run an agent, both set by the instance's storage, `node:sqlite`: Bun ships it from 1.4.0,
 * and Node stops calling it experimental, and printing so on every start, from 24.15.0.
 */
export const RUNTIME_FLOOR = { node: "24.15.0", bun: "1.4.0" } as const;

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
export function unsupportedRuntime(versions: { node: string; bun?: string } = process.versions): string | undefined {
  const [name, version, floor] =
    versions.bun === undefined ? ["Node", versions.node, RUNTIME_FLOOR.node] : ["Bun", versions.bun, RUNTIME_FLOOR.bun];
  return belowFloor(version, floor) ? `fastagent needs ${name} ${floor} or later; this is ${version}` : undefined;
}

/**
 * Whether a manifest lists FastAgent, which the image of an agent with a `package.json` runs from its own
 * `node_modules`: without it, the container cannot start.
 */
export function listsFastagent(pkg: {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
}): boolean {
  return "@fastagent-sh/fastagent" in { ...pkg.dependencies, ...pkg.devDependencies };
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
