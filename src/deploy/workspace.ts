/** Deployment-owned initialization; the workspace itself belongs to the running agent. */
import { cp, lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { once } from "node:events";
import type { Readable } from "node:stream";
import { writeFileAtomic } from "../atomic-write.ts";
import { log } from "../log.ts";
import { exists } from "../paths.ts";

export const RELEASE_FILE = "fastagent.release.json";

export interface DeploymentRelease {
  version: 1;
  id: string;
  agent: string;
}

/** The manifest names a directory the container joins onto the workspace root, so the spelling is
 *  constrained. `deploy` asks BEFORE generating artifacts — a name `init` accepts but this rejects
 *  is the author's directory name, not a corrupt manifest. */
export function isReleaseAgentName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

export function parseDeploymentRelease(raw: string): DeploymentRelease {
  const r = JSON.parse(raw) as DeploymentRelease;
  if (
    r?.version !== 1 ||
    typeof r.id !== "string" ||
    !r.id ||
    typeof r.agent !== "string" ||
    !isReleaseAgentName(r.agent)
  ) {
    throw new Error("invalid deployment release manifest");
  }
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
  // Logged on BOTH paths: rebuilding an image without regenerating the manifest keeps the id, and a
  // deployment that silently kept the old definition looks identical to one that took the new one.
  if (applied?.id === release.id) {
    log.info(`[fastagent] release ${release.id} is already applied — keeping the workspace's definition`);
    return workspace;
  }
  const initial = applied === undefined;
  if (initial && (await exists(workspace)))
    throw new Error(`refusing to initialize over an existing unowned workspace: ${workspace}`);
  const definition = join(source, release.agent);
  if (!(await exists(definition)) || !(await lstat(definition)).isDirectory())
    throw new Error(`the release must contain a nested agent directory: ${definition}`);
  log.info(
    initial
      ? `[fastagent] seeding the workspace from release ${release.id}`
      : `[fastagent] publishing release ${release.id} over base/${release.agent}`,
  );
  await rm(staged, { recursive: true, force: true });
  await cp(initial ? source : join(source, release.agent), staged, { recursive: true, verbatimSymlinks: true });
  const pending: PendingRelease = { release, initial };
  writeFileAtomic(pendingPath, JSON.stringify(pending));
  await finishRelease(root, pending);
  return workspace;
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

/** `waitSeconds` covers a restart overlapping the old process's exit; a test that wants the refusal
 *  passes a short one rather than waiting out the deployment default. */
export async function leaseDeployment(metadata: string, waitSeconds = 35): Promise<() => Promise<void>> {
  // flock locks the shared open-file description. The parent's raw fd survives GC and closes at exit.
  // Never unlink this inode: another starter may already have it open.
  const fd = openSync(join(metadata, "lock"), "a", 0o600);
  try {
    const child = spawn("flock", ["--exclusive", "--wait", String(waitSeconds), "3"], {
      stdio: ["ignore", "ignore", "pipe", fd],
    });
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
    // A custom base image without util-linux fails every boot; the bare spawn error names neither
    // the binary nor why a lease needs one.
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`the deployed workspace lease needs the \`flock\` binary (util-linux): ${String(error)}`);
    throw error;
  }
}

/**
 * Prepare the deployed workspace and return its path.
 *
 * The lease is NOT returned: it stays held for the process lifetime, because channel activation can
 * start background writers that `close()` does not drain. The kernel drops it when the process exits.
 */
export async function prepareDeployment(source: string, root: string, release: DeploymentRelease): Promise<string> {
  await assertStorageMounted(root);
  const meta = join(root, ".deployment");
  await mkdir(meta, { recursive: true });
  const unlock = await leaseDeployment(meta);
  try {
    return await applyDeploymentRelease(source, root, release);
  } catch (error) {
    await unlock();
    throw error;
  }
}
