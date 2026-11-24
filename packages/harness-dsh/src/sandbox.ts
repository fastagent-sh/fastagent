/**
 * Translates FastAgent's sandbox posture into DSH's `LocalSandboxProvider` `SandboxPolicy`
 * and enforces canonical `realpath` path confinement for in-process filesystem tools.
 */
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { SandboxPolicy as DshRuntimeSandboxPolicy, SandboxProvider } from "@deepseek-ai/dsh-sandbox";
import type { SessionId } from "@deepseek-ai/dsh-session";
import { agentError } from "@fastagent-sh/client/agent-api";
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

/**
 * Probe and cache the OS sandbox runner at startup so misconfigured containers fail fast instead of
 * reporting healthy and failing on the first `bash` tool call.
 */
export async function verifyBashSandbox(
  provider: Pick<SandboxProvider, "confine"> | undefined,
  options: { readonly workdir: string; readonly mode: DshSandboxMode },
): Promise<void> {
  if (options.mode === "off") return;
  const runtimePolicy = toRuntimeSandboxPolicy(options);
  if (provider === undefined || runtimePolicy === undefined) {
    throw agentError("unavailable", "OS sandbox is required for bash tools, but no sandbox provider is available");
  }
  try {
    await provider.confine(["true"], runtimePolicy);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw agentError(
      "unavailable",
      `OS sandbox (${options.mode}) is unavailable for bash tools on this host: ${detail}. ` +
        `Enable a supported OS sandbox (bwrap or Landlock on Linux, sandbox-exec on macOS), remove "bash" from codingTools, or set sandbox: "off".`,
    );
  }
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
  if (!targetPath || typeof targetPath !== "string" || targetPath.includes("\0")) {
    throw new Error("Path must be a non-empty string without NUL bytes");
  }
  const canonicalRoot = safeRealpath(workdir);
  const candidate = isAbsolute(targetPath) ? resolve(targetPath) : resolve(canonicalRoot, targetPath);

  const resolveExisting = (entryPath: string): string | undefined => {
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(entryPath);
    } catch {
      return undefined;
    }
    if (stat.isSymbolicLink()) {
      let resolvedLink: string;
      try {
        resolvedLink = realpathSync(entryPath);
      } catch {
        throw new Error(`Refusing dangling symlink: ${targetPath}`);
      }
      if (!isInsideRoot(canonicalRoot, resolvedLink)) {
        throw new Error(`Path escapes workspace: ${targetPath}`);
      }
      return resolvedLink;
    }
    const resolved = realpathSync(entryPath);
    if (!isInsideRoot(canonicalRoot, resolved)) {
      throw new Error(`Path escapes workspace: ${targetPath}`);
    }
    return resolved;
  };

  const direct = resolveExisting(candidate);
  if (direct !== undefined) return direct;

  // Target does not exist yet: walk up to the nearest existing ancestor (checking lstat first so
  // dangling directory symlinks are rejected immediately rather than skipped).
  const trailingSegments: string[] = [];
  let current = candidate;
  for (;;) {
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`Path escapes workspace: ${targetPath}`);
    }
    trailingSegments.unshift(relative(parent, current));
    current = parent;
    const resolvedAncestor = resolveExisting(current);
    if (resolvedAncestor !== undefined) {
      const finalPath = resolve(resolvedAncestor, ...trailingSegments);
      if (!isInsideRoot(canonicalRoot, finalPath)) {
        throw new Error(`Path escapes workspace: ${targetPath}`);
      }
      return finalPath;
    }
  }
}
