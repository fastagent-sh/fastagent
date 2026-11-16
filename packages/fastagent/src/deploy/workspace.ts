/**
 * A deployed box's initialization of its storage: the lease, and the record of which agent the storage is for. The
 * program is the image's; the storage is the instance's root, its working directory with its state (`.state/`), which
 * outlives every image.
 */
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { once } from "node:events";
import type { Readable } from "node:stream";
import { writeFileAtomic } from "../atomic-write.ts";
import { log } from "../log.ts";
import { exists } from "../paths.ts";
import { INSTANCE_NAME_ENV } from "../instance-name.ts";

const SEGMENT = /^[a-zA-Z0-9_-]+$/;

/** The box's own bookkeeping on the storage: the lease, and the agent the storage belongs to. */
const deploymentMeta = (root: string): string => join(root, ".deployment");

/** The agent's name, one path segment of letters, digits, `-` and `_`, as the storage records it. */
function parseOwner(raw: string): string {
  const record = JSON.parse(raw) as { version?: unknown; agent?: unknown };
  if (record?.version !== 1 || typeof record.agent !== "string" || !SEGMENT.test(record.agent)) {
    throw new Error("invalid storage owner record");
  }
  return record.agent;
}

/** The agent this box runs, as the generated image names it (`FASTAGENT_NAME`), so its storage belongs to someone. */
export function storageOwnerFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const agent = env[INSTANCE_NAME_ENV];
  if (!agent) {
    throw new Error(
      `${INSTANCE_NAME_ENV} is required for a deployment: it names the agent its storage belongs to, and the ` +
        "generated Dockerfile sets it",
    );
  }
  if (!SEGMENT.test(agent))
    throw new Error(`${INSTANCE_NAME_ENV} must be one path segment, got ${JSON.stringify(agent)}`);
  return agent;
}

/** Call while holding the lease. Records `agent` as the storage's owner, refusing a storage another agent owns. */
async function claimDeploymentStorage(root: string, agent: string): Promise<void> {
  const ownerPath = join(deploymentMeta(root), "applied.json");
  const owner = (await exists(ownerPath)) ? parseOwner(await readFile(ownerPath, "utf8")) : undefined;
  if (owner !== undefined && owner !== agent) {
    throw new Error(`this box runs ${agent}, but the storage at ${root} belongs to ${owner}`);
  }
  log.info(`[fastagent] storage ${root} of ${agent}`);
  if (owner === undefined) writeFileAtomic(ownerPath, JSON.stringify({ version: 1, agent }));
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
async function assertStorageMounted(root: string, paths?: string[]): Promise<void> {
  if (!(paths ?? (await mountedPaths())).includes(resolve(root)))
    throw new Error(`persistent storage is not mounted at ${root}`);
}

/** `waitSeconds` covers a restart overlapping the old process's exit; a test that wants the refusal
 *  passes a short one rather than waiting out the deployment default. */
async function leaseDeployment(metadata: string, waitSeconds = 35): Promise<() => Promise<void>> {
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
 * storage of `agent`.
 *
 * The lease is NOT returned: it stays held for the process lifetime, because background writers may outlive
 * `close()`. The kernel drops it when the process exits.
 */
export async function prepareDeployment(root: string, agent: string): Promise<void> {
  await assertStorageMounted(root);
  const meta = deploymentMeta(root);
  await mkdir(meta, { recursive: true });
  const unlock = await leaseDeployment(meta);
  try {
    await claimDeploymentStorage(root, agent);
  } catch (error) {
    await unlock();
    throw error;
  }
}
