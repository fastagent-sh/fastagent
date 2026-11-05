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
import { exists } from "../paths.ts";

export const RELEASE_FILE = "fastagent.release.json";

/** The deployment's own bookkeeping on the storage: the lease, and the release last started on it. */
const deploymentMeta = (root: string): string => join(root, ".deployment");

export interface DeploymentRelease {
  version: 1;
  id: string;
  agent: string;
  /**
   * The model this release resolved, when the deployed environment's value file named it (`config.model` needs
   * nothing here — the config ships in the image too). NON-CREDENTIAL configuration only: the manifest travels
   * inside the image, which is readable by anyone who can pull it, and it is rebuilt on every deploy — both are the
   * opposite of what a credential needs (see docs/design/configuration.md §8).
   */
  model?: string;
  /**
   * The instance configuration this release delivers: a file beside the manifest, by its name. Configuration only,
   * like `model`: it holds no secret value.
   */
  config?: string;
}

/**
 * Where a deploy writes the instance configuration it delivers, relative to the release manifest: a directory of its
 * own, apart from the program's, because what an instance configuration names beside it (its `.mcp.json`, its text) is
 * read from its own directory, and the program's directory holds the program's.
 */
export const DELIVERED_CONFIG_FILE = "fastagent.instance/fastagent.json";

/** The manifest names the agent the storage belongs to, and that name is also a content entry's name rule (one path
 *  segment). `deploy` asks BEFORE generating artifacts — a name `init` accepts but this rejects is the author's
 *  directory name, not a corrupt manifest. */
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
    !isReleaseAgentName(r.agent) ||
    (r.model !== undefined && !isModelSpec(r.model)) ||
    (r.config !== undefined && r.config !== DELIVERED_CONFIG_FILE)
  ) {
    throw new Error("invalid deployment release manifest");
  }
  return r;
}

/**
 * Project a release's own declarations into the environment it was resolved FOR — the receiving half of the model
 * chain, run by `prepareStartWorkspace` BEFORE the agent's `.env` is read (so either source outranks a value
 * edited on the box).
 *
 * `||=`: a variable the platform already holds still wins, because the deployment declares only the half of this
 * environment it can. The log names whichever source actually won — the remedies differ, and a redeploy does
 * nothing at all to a platform-set variable.
 */
export function applyReleaseEnv(release: DeploymentRelease, env: NodeJS.ProcessEnv = process.env): void {
  const fromPlatform = env.FASTAGENT_MODEL;
  if (release.model && !fromPlatform) env.FASTAGENT_MODEL = release.model;
  const effective = env.FASTAGENT_MODEL;
  if (!effective) return;
  log.info(
    `[fastagent] model ${effective} — from ${
      fromPlatform
        ? `a FASTAGENT_MODEL already set in this environment${
            release.model ? ", which outranks the release manifest" : ""
          }`
        : "the release manifest (redeploy to change it)"
    }; editing FASTAGENT_MODEL in the deployed agent's .env does not override it`,
  );
}

/** A `provider/modelId` spec. The id itself may carry `/` and `~` (`baseten/zai-org/GLM-5.3`, openrouter aliases);
 *  resolution only ever splits on the first slash. */
export function isModelSpec(value: string): boolean {
  return /^\S+\/\S+$/.test(value);
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
