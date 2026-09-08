/** Deployment-owned initialization; the workspace itself belongs to the running agent. */
import { cp, lstat, mkdir, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { join, resolve, posix } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { closeSync, openSync } from "node:fs";
import { once } from "node:events";
import type { Readable } from "node:stream";
import { writeFileAtomic } from "../atomic-write.ts";
import { exists, isUnderDir } from "../paths.ts";

export const RELEASE_FILE = "fastagent.release.json";

export interface DeploymentRelease {
  version: 1;
  id: string;
  agent: string;
  temporaryDirectories: string[];
}

export function validateTemporaryDirectories(value: unknown): asserts value is string[] {
  if (!Array.isArray(value)) throw new Error("deploy.temporaryDirectories must be an array of relative directories");
  for (const path of value) {
    if (
      typeof path !== "string" ||
      path === "" ||
      path === "." ||
      path.startsWith("/") ||
      path.endsWith("/") ||
      path.includes("\0") ||
      path.includes("\\") ||
      posix.normalize(path) !== path ||
      path.split("/").some((part) => ["..", ".git", ".state", ".secrets", ".deployment"].includes(part))
    )
      throw new Error(`invalid temporary directory: ${JSON.stringify(path)}`);
  }
  for (const [i, path] of value.entries()) {
    if (
      value.slice(i + 1).some((other) => path === other || path.startsWith(`${other}/`) || other.startsWith(`${path}/`))
    ) {
      throw new Error(`overlapping temporary directory: ${path}`);
    }
  }
}

export function parseDeploymentRelease(raw: string): DeploymentRelease {
  const r = JSON.parse(raw) as DeploymentRelease;
  if (
    r?.version !== 1 ||
    typeof r.id !== "string" ||
    !r.id ||
    typeof r.agent !== "string" ||
    !/^[a-zA-Z0-9_-]+$/.test(r.agent)
  ) {
    throw new Error("invalid deployment release manifest");
  }
  validateTemporaryDirectories(r.temporaryDirectories);
  if (r.temporaryDirectories.some((path) => path === r.agent))
    throw new Error("the agent definition cannot be temporary");
  return r;
}

interface PendingRelease {
  release: DeploymentRelease;
  initial: boolean;
}

/** A completed staging tree is published before its journal; readers start only after recovery. */
async function finishRelease(root: string, pending: PendingRelease): Promise<void> {
  const meta = join(root, ".deployment"),
    staged = join(meta, "staged"),
    previous = join(meta, "previous");
  const target = pending.initial ? join(root, "base") : join(root, "base", pending.release.agent);
  if (await exists(staged)) {
    if (await exists(target)) {
      if (pending.initial || (await exists(previous))) throw new Error(`deployment recovery conflict at ${target}`);
      await rename(target, previous);
    }
    await rename(staged, target);
  } else if (!(await exists(target))) {
    throw new Error(`deployment recovery has neither staged nor active content: ${target}`);
  }
  writeFileAtomic(join(meta, "applied.json"), JSON.stringify(pending.release));
  await rm(previous, { recursive: true, force: true });
  await rm(join(meta, "pending.json"));
}

/** Call while holding the workspace lease. No deployment replaces existing work outside the definition. */
export async function applyDeploymentRelease(
  source: string,
  root: string,
  release: DeploymentRelease,
): Promise<string> {
  const meta = join(root, ".deployment"),
    staged = join(meta, "staged"),
    pendingPath = join(meta, "pending.json");
  await mkdir(meta, { recursive: true });
  if (await exists(pendingPath)) {
    const pending = JSON.parse(await readFile(pendingPath, "utf8")) as PendingRelease;
    pending.release = parseDeploymentRelease(JSON.stringify(pending.release));
    if (typeof pending.initial !== "boolean") throw new Error("invalid pending deployment journal");
    await finishRelease(root, pending);
  }
  const appliedPath = join(meta, "applied.json");
  const applied = (await exists(appliedPath)) ? parseDeploymentRelease(await readFile(appliedPath, "utf8")) : undefined;
  const workspace = join(root, "base");
  if (applied?.agent !== undefined && applied.agent !== release.agent) {
    throw new Error(`deployment selects ${release.agent}, but this workspace belongs to ${applied.agent}`);
  }
  if (applied?.id === release.id) return workspace;
  const initial = applied === undefined;
  if (initial && (await exists(workspace)))
    throw new Error(`refusing to initialize over an existing unowned workspace: ${workspace}`);
  if (!(await lstat(join(source, release.agent))).isDirectory())
    throw new Error("the release must contain a nested agent directory");
  await rm(staged, { recursive: true, force: true });
  await cp(initial ? source : join(source, release.agent), staged, { recursive: true, verbatimSymlinks: true });
  const pending: PendingRelease = { release, initial };
  writeFileAtomic(pendingPath, JSON.stringify(pending));
  await finishRelease(root, pending);
  return workspace;
}

const execute = promisify(execFile);

/** Mount only explicitly disposable directories. A failed mount never falls back to durable writes. */
export async function mountTemporaryDirectories(
  workspace: string,
  directories: string[],
  temporaryRoot: string,
  mount: (source: string, target: string) => Promise<void> = async (source, target) => {
    await execute("mount", ["--bind", source, target]);
  },
): Promise<void> {
  validateTemporaryDirectories(directories);
  for (const path of directories) {
    const source = join(temporaryRoot, path);
    let target = workspace;
    for (const part of path.split("/")) {
      target = join(target, part);
      await mkdir(target, { recursive: true });
      if ((await lstat(target)).isSymbolicLink() || !isUnderDir(await realpath(target), await realpath(workspace))) {
        throw new Error(`temporary directory escapes the workspace or is a symlink: ${target}`);
      }
    }
    const entries = await readdir(target);
    if (entries.length > 0) {
      await rm(source, { recursive: true, force: true });
      await cp(target, source, { recursive: true, verbatimSymlinks: true });
      for (const entry of entries) await rm(join(target, entry), { recursive: true, force: true });
    } else {
      await mkdir(source, { recursive: true });
    }
    await mount(source, target);
  }
}

async function mountedPaths(): Promise<string[]> {
  const mounts = await readFile("/proc/self/mountinfo", "utf8");
  return mounts
    .split("\n")
    .map((line) =>
      line
        .split(" ")[4]
        ?.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8))),
    )
    .filter((path): path is string => path !== undefined);
}

/** An unmounted directory must never look like a new disk. */
export async function assertStorageMounted(root: string, paths?: string[]): Promise<void> {
  if (!(paths ?? (await mountedPaths())).includes(resolve(root)))
    throw new Error(`persistent storage is not mounted at ${root}`);
}

export async function unmountWorkspace(
  workspace: string,
  paths: string[],
  unmount: (path: string) => Promise<void> = async (path) => {
    await execute("umount", [path]);
  },
): Promise<void> {
  for (const path of paths
    .filter((path) => path !== workspace && isUnderDir(path, workspace))
    .sort((a, b) => b.length - a.length)) {
    await unmount(path);
  }
}

export async function leaseDeployment(metadata: string): Promise<() => Promise<void>> {
  // flock locks the shared open-file description. The parent's raw fd survives GC and closes at exit.
  // Never unlink this inode: another starter may already have it open.
  const fd = openSync(join(metadata, "lock"), "a", 0o600);
  try {
    const child = spawn("flock", ["--exclusive", "--wait", "35", "3"], { stdio: ["ignore", "ignore", "pipe", fd] });
    let stderr = "";
    (child.stderr as Readable).setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const [code, signal] = await once(child, "close");
    if (code !== 0)
      throw new Error(`could not acquire workspace lease at ${metadata}: flock ${signal ?? code} ${stderr.trim()}`);
    return async () => {
      closeSync(fd);
    };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** The returned lease stays held for the process lifetime, including invocation and definition reads. */
export async function prepareDeployment(
  source: string,
  root: string,
  release: DeploymentRelease,
): Promise<{ workspace: string; release: () => Promise<void> }> {
  await assertStorageMounted(root);
  const meta = join(root, ".deployment");
  await mkdir(meta, { recursive: true });
  const unlock = await leaseDeployment(meta);
  try {
    // Another starter can attach mounts while this process waits for the lease.
    await unmountWorkspace(join(root, "base"), await mountedPaths());
    const workspace = await applyDeploymentRelease(source, root, release);
    await mountTemporaryDirectories(workspace, release.temporaryDirectories, "/tmp/fastagent/directories");
    return { workspace, release: unlock };
  } catch (error) {
    await unlock();
    throw error;
  }
}
