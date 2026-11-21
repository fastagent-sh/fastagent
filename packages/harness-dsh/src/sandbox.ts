/**
 * Translates FastAgent's sandbox posture into DSH's `LocalSandboxProvider` `SandboxPolicy`
 * and enforces canonical `realpath` path confinement for in-process filesystem tools.
 */
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { SandboxPolicy as DshRuntimeSandboxPolicy } from "@deepseek-ai/dsh-sandbox";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { DshSandboxMode, DshSandboxPolicy } from "./types.ts";

/**
 * Build a `DshSandboxPolicy` for `workdir`, or `undefined` when `mode === "off"`.
 * - `"workspace"`: read/write confined to `workdir`.
 * - `"read-only"`: read confined to `workdir`, no writable paths.
 */
export function buildDshSandboxPolicy(options: {
  readonly workdir: string;
  readonly mode?: DshSandboxMode;
  readonly network?: boolean;
  readonly extraReadablePaths?: readonly string[];
}): DshSandboxPolicy | undefined {
  const mode = options.mode ?? "workspace";
  if (mode === "off") return undefined;
  if (!isAbsolute(options.workdir)) {
    throw new Error(`DSH sandbox workdir must be an absolute path, got ${JSON.stringify(options.workdir)}`);
  }
  const readablePaths = [options.workdir, ...(options.extraReadablePaths ?? [])];
  for (const path of readablePaths) {
    if (!isAbsolute(path)) {
      throw new Error(`DSH sandbox path must be absolute, got ${JSON.stringify(path)}`);
    }
  }
  return {
    workspace: options.workdir,
    writablePaths: mode === "workspace" ? [options.workdir] : [],
    readablePaths,
    network: options.network === true ? "allow" : "none",
  };
}

/**
 * Translate FastAgent's `DshSandboxMode` into `@deepseek-ai/dsh-sandbox`'s runtime `SandboxPolicy`.
 * Returns `undefined` only when `mode === "off"`.
 */
export function toRuntimeSandboxPolicy(options: {
  readonly workdir: string;
  readonly mode: DshSandboxMode;
  readonly sessionId?: SessionId;
}): DshRuntimeSandboxPolicy | undefined {
  if (options.mode === "off") return undefined;
  if (!isAbsolute(options.workdir)) {
    throw new Error(`DSH sandbox workdir must be an absolute path, got ${JSON.stringify(options.workdir)}`);
  }
  const workspaceRoot = safeRealpath(options.workdir);
  return {
    mode: options.mode === "read-only" ? "read-only" : "workspace-write",
    workspaceRoot,
    ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
  };
}

function safeRealpath(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return resolve(target);
  }
}

function isInsideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve `targetPath` relative to `workdir` and verify it cannot escape `workdir`
 * through `..` traversal, existing symlinks, or dangling symlinks pointing outside the workspace.
 * @public
 */
export function resolveConfinedPath(workdir: string, targetPath: string): string {
  if (!isAbsolute(workdir)) {
    throw new Error(`DSH workdir must be an absolute path, got ${JSON.stringify(workdir)}`);
  }
  if (!targetPath || typeof targetPath !== "string") {
    throw new Error("Path must be a non-empty string");
  }
  const canonicalRoot = safeRealpath(workdir);
  const candidate = isAbsolute(targetPath) ? resolve(targetPath) : resolve(canonicalRoot, targetPath);

  // If the target itself exists (including a dangling symlink via lstat), resolve its real target.
  try {
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink()) {
      // Try realpath first; if it's a dangling symlink, reject outright to prevent escape on write.
      let resolvedLink: string;
      try {
        resolvedLink = realpathSync(candidate);
      } catch {
        throw new Error(`Refusing symlink outside workspace: ${targetPath}`);
      }
      if (!isInsideRoot(canonicalRoot, resolvedLink)) {
        throw new Error(`Path escapes workspace: ${targetPath}`);
      }
      return resolvedLink;
    }
    const resolved = realpathSync(candidate);
    if (!isInsideRoot(canonicalRoot, resolved)) {
      throw new Error(`Path escapes workspace: ${targetPath}`);
    }
    return resolved;
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("escapes workspace") || error.message.includes("Refusing symlink"))
    ) {
      throw error;
    }
    // Target does not exist yet: walk up to the nearest existing ancestor and verify its realpath is inside root.
    const trailingSegments: string[] = [];
    let current = candidate;
    for (;;) {
      const parent = dirname(current);
      if (parent === current) {
        throw new Error(`Path escapes workspace: ${targetPath}`);
      }
      trailingSegments.unshift(relative(parent, current));
      current = parent;
      try {
        const resolvedAncestor = realpathSync(current);
        if (!isInsideRoot(canonicalRoot, resolvedAncestor)) {
          throw new Error(`Path escapes workspace: ${targetPath}`);
        }
        const finalPath = resolve(resolvedAncestor, ...trailingSegments);
        if (!isInsideRoot(canonicalRoot, finalPath)) {
          throw new Error(`Path escapes workspace: ${targetPath}`);
        }
        return finalPath;
      } catch (ancestorError) {
        if (ancestorError instanceof Error && ancestorError.message.includes("escapes workspace")) {
          throw ancestorError;
        }
      }
    }
  }
}
