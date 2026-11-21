/**
 * Translates FastAgent's sandbox posture into DSH's `LocalSandboxProvider` `SandboxPolicy`.
 * Fails fast on non-absolute workdirs and defaults to no network access.
 */
import { isAbsolute } from "node:path";
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
