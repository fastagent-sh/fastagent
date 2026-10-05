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
 * Parse `<dir>/package.json`, or `{}` when there is none (a markdown-only agent). A file that does not parse throws,
 * naming itself: read as `{}` it became "does not list @fastagent-sh/fastagent" and an npm-based image, both wrong.
 */
export async function readPackageJson(dir: string): Promise<{
  packageManager?: unknown;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
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
