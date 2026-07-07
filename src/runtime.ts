import { existsSync } from "node:fs";
import { join } from "node:path";

export interface WorkspaceRuntime {
  /** The JS runtime the workspace targets — drives the generated Dockerfile base + install/run commands
   *  and the package-manager hints in `init`/`add`. */
  runtime: "node" | "bun";
  /** For `runtime: "bun"`, the version from package.json's `packageManager: "bun@x"` (undefined if a bun
   *  lockfile made it bun but no version is pinned). */
  bunVersion?: string;
  /** Whether the runtime's lockfile is present (package-lock.json for node, bun.lock/bun.lockb for bun). */
  hasLockfile: boolean;
}

/**
 * Detect which JS runtime a workspace targets: `bun` when package.json's `packageManager` is `bun@…` OR a
 * bun lockfile (bun.lock/bun.lockb) is present, else `node`. `pkg` is the already-parsed package.json (or
 * `{}` when there is none / it is malformed). One source for the deploy Dockerfile and the CLI hints, so
 * they agree on what the workspace is.
 */
export function detectRuntime(dir: string, pkg: { packageManager?: unknown }): WorkspaceRuntime {
  const pm = typeof pkg.packageManager === "string" ? pkg.packageManager : "";
  const bunLock = existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"));
  if (pm.startsWith("bun@") || bunLock) {
    // corepack pins as `bun@1.3.13+sha256.<hash>`; the version (a Docker tag for oven/bun) is the part
    // BEFORE `+` — keeping the hash would build an invalid `FROM oven/bun:1.3.13+sha256…` tag.
    return { runtime: "bun", bunVersion: pm.match(/^bun@([^+]+)/)?.[1], hasLockfile: bunLock };
  }
  return { runtime: "node", hasLockfile: existsSync(join(dir, "package-lock.json")) };
}
