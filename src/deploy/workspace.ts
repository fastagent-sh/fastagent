/**
 * Deployment-owned initialization of a host's storage: the lease, and the record of which agent the storage is for.
 * The program is the image's, read where it is built; the storage is the instance's root, its working directory with
 * its state, credentials and content (`.state/`, `.secrets/`, `content/`), which outlives every release.
 */
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { once } from "node:events";
import type { Readable } from "node:stream";
import { writeFileAtomic } from "../atomic-write.ts";
import { log } from "../log.ts";
import { RELEASE_ID_ENV, exists } from "../paths.ts";
import { INSTANCE_NAME_ENV } from "../instance-name.ts";

const SEGMENT = /^[a-zA-Z0-9_-]+$/;

/** The deployment's own bookkeeping on the storage: the lease, and the release last started on it. */
const deploymentMeta = (root: string): string => join(root, ".deployment");

/** What a deploy set on the box that the storage remembers: the instance it belongs to, and the release last started. */
export interface DeploymentRelease {
  version: 1;
  id: string;
  agent: string;
}

/** The agent's name is one path segment of letters, digits, `-` and `_`, as a content entry's name is. */
export function parseDeploymentRelease(raw: string): DeploymentRelease {
  const r = JSON.parse(raw) as DeploymentRelease;
  if (r?.version !== 1 || typeof r.id !== "string" || !r.id || typeof r.agent !== "string" || !SEGMENT.test(r.agent)) {
    throw new Error("invalid deployment release record");
  }
  return r;
}

/**
 * The release this box was started as, from the variables a deploy sets on it. A deployed box without a name is a
 * deployment someone assembled by hand, and its storage would belong to nobody.
 */
export function releaseFromEnv(env: NodeJS.ProcessEnv = process.env): DeploymentRelease {
  const id = env[RELEASE_ID_ENV];
  const agent = env[INSTANCE_NAME_ENV];
  if (!id) throw new Error(`${RELEASE_ID_ENV} is required for a deployment`);
  if (!agent)
    throw new Error(`${INSTANCE_NAME_ENV} is required for a deployment: it names the agent its storage belongs to`);
  return parseDeploymentRelease(JSON.stringify({ version: 1, id, agent }));
}

/**
 * Call while holding the deployment lease. Records `release` as the one started on the storage at `root`, refusing a
 * storage another agent's deployments started on: its state is that agent's.
 */
export async function claimDeploymentStorage(root: string, release: DeploymentRelease): Promise<void> {
  const meta = deploymentMeta(root);
  const appliedPath = join(meta, "applied.json");
  const applied = (await exists(appliedPath)) ? parseDeploymentRelease(await readFile(appliedPath, "utf8")) : undefined;
  if (applied !== undefined && applied.agent !== release.agent) {
    throw new Error(`deployment selects ${release.agent}, but this storage belongs to ${applied.agent}`);
  }
  log.info(`[fastagent] release ${release.id} on ${root}`);
  if (applied?.id !== release.id) writeFileAtomic(appliedPath, JSON.stringify(release));
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
      throw new Error(`could not acquire deployment lease at ${metadata}: flock ${signal ?? code} ${stderr.trim()}`);
    return async () => {
      closeSync(fd);
    };
  } catch (error) {
    closeSync(fd);
    // A custom base image without util-linux fails every boot; the bare spawn error names neither
    // the binary nor why a lease needs one.
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`the deployment lease needs the \`flock\` binary (util-linux): ${String(error)}`);
    throw error;
  }
}

/**
 * Take the deployment's storage at `root`: it must be a mount, one process holds it (the lease), and it is the
 * storage of the agent `release` names.
 *
 * The lease is NOT returned: it stays held for the process lifetime, because channel activation can
 * start background writers that `close()` does not drain. The kernel drops it when the process exits.
 */
export async function prepareDeployment(root: string, release: DeploymentRelease): Promise<void> {
  await assertStorageMounted(root);
  const meta = deploymentMeta(root);
  await mkdir(meta, { recursive: true });
  const unlock = await leaseDeployment(meta);
  try {
    await claimDeploymentStorage(root, release);
  } catch (error) {
    await unlock();
    throw error;
  }
}
