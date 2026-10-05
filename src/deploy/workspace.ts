/**
 * Deployment-owned initialization of a host's storage: the lease, the release journal, and the definition each
 * release replaces. The instance's state and credentials (`.state/`, `.secrets/`) sit beside the definition and
 * outlive every release.
 */
import { cp, lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { once } from "node:events";
import type { Readable } from "node:stream";
import { writeFileAtomic } from "../atomic-write.ts";
import { log } from "../log.ts";
import { exists } from "../paths.ts";
import { detectRuntime, readPackageJson } from "../runtime.ts";

export const RELEASE_FILE = "fastagent.release.json";

/** Where the storage holds the deployed definition, the agent's working directory on the host. */
export const DEPLOYED_DEFINITION_DIR = "definition";

/** The deployment's own bookkeeping on the storage: the lease, the release journal, the install marker. */
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
}

/** The manifest names the agent the storage belongs to, and that name is also a context's name rule (one path
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
    (r.model !== undefined && !isModelSpec(r.model))
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

/** A completed staging tree is published before its journal; readers start only after recovery. */
async function finishRelease(root: string, release: DeploymentRelease): Promise<void> {
  const meta = deploymentMeta(root),
    staged = join(meta, "staged"),
    previous = join(meta, "previous");
  const target = join(root, DEPLOYED_DEFINITION_DIR);
  if (await exists(staged)) {
    if (await exists(target)) {
      if (await exists(previous)) throw new Error(`deployment recovery conflict at ${target}`);
      await rename(target, previous);
    }
    await rename(staged, target);
  } else if (!(await exists(target))) {
    throw new Error(`deployment recovery has neither staged nor active content: ${target}`);
  }
  writeFileAtomic(join(meta, "applied.json"), JSON.stringify(release));
  await rm(previous, { recursive: true, force: true });
  await rm(join(meta, "pending.json"));
}

/**
 * Call while holding the deployment lease. Replaces the deployed definition with the release's (`source`, the image's
 * copy) and returns where it now is; nothing else on the storage is touched.
 */
export async function applyDeploymentRelease(
  source: string,
  root: string,
  release: DeploymentRelease,
): Promise<string> {
  const meta = deploymentMeta(root),
    staged = join(meta, "staged"),
    pendingPath = join(meta, "pending.json");
  await mkdir(meta, { recursive: true });
  // A storage an earlier FastAgent laid out holds the agent's whole workspace there, which this one would leave
  // behind unread: said, never silently abandoned.
  const formerWorkspace = join(root, "base");
  if (await exists(formerWorkspace)) {
    throw new Error(
      `${formerWorkspace} holds a workspace from an earlier FastAgent, which no longer copies one to the host — ` +
        `move out what you need and delete it, or deploy onto fresh storage`,
    );
  }
  if (await exists(pendingPath)) {
    const pending = parseDeploymentRelease(await readFile(pendingPath, "utf8"));
    await finishRelease(root, pending);
  }
  const appliedPath = join(meta, "applied.json");
  const applied = (await exists(appliedPath)) ? parseDeploymentRelease(await readFile(appliedPath, "utf8")) : undefined;
  const definition = join(root, DEPLOYED_DEFINITION_DIR);
  if (applied?.agent !== undefined && applied.agent !== release.agent) {
    throw new Error(`deployment selects ${release.agent}, but this storage belongs to ${applied.agent}`);
  }
  // Logged on BOTH paths: rebuilding an image without regenerating the manifest keeps the id, and a
  // deployment that silently kept the old definition looks identical to one that took the new one.
  if (applied?.id === release.id) {
    log.info(`[fastagent] release ${release.id} is already applied — keeping the deployed definition`);
    return definition;
  }
  if (applied === undefined && (await exists(definition))) {
    throw new Error(`refusing to initialize over an existing unowned definition: ${definition}`);
  }
  if (!(await exists(source)) || !(await lstat(source)).isDirectory()) {
    throw new Error(`the release must contain its agent directory: ${source}`);
  }
  log.info(`[fastagent] publishing release ${release.id} as ${DEPLOYED_DEFINITION_DIR}/`);
  await rm(staged, { recursive: true, force: true });
  await cp(source, staged, { recursive: true, verbatimSymlinks: true });
  writeFileAtomic(pendingPath, JSON.stringify(release));
  await finishRelease(root, release);
  return definition;
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
 * Prepare the deployed definition and return its path.
 *
 * The lease is NOT returned: it stays held for the process lifetime, because channel activation can
 * start background writers that `close()` does not drain. The kernel drops it when the process exits.
 */
export async function prepareDeployment(source: string, root: string, release: DeploymentRelease): Promise<string> {
  await assertStorageMounted(root);
  const meta = deploymentMeta(root);
  await mkdir(meta, { recursive: true });
  const unlock = await leaseDeployment(meta);
  try {
    return await applyDeploymentRelease(source, root, release);
  } catch (error) {
    await unlock();
    throw error;
  }
}

/**
 * Install the deployed agent's dependencies into the storage when it has no installed CLI yet (a fresh volume), or
 * when an earlier install died part-way — its `installing` marker is still there, so the next boot redoes it.
 */
export async function installAgentDependencies(root: string, agentDir: string): Promise<void> {
  const installing = join(deploymentMeta(root), "installing");
  // A failed install can leave the CLI link in place before its dependencies are complete.
  if ((await exists(installing)) || !(await exists(join(agentDir, "node_modules/.bin/fastagent")))) {
    const { runtime, hasLockfile } = detectRuntime(agentDir, await readPackageJson(agentDir));
    const args =
      runtime === "bun" ? ["install", ...(hasLockfile ? ["--frozen-lockfile"] : [])] : [hasLockfile ? "ci" : "install"];
    writeFileAtomic(installing, "");
    log.info(`[fastagent] installing the agent's dependencies (${runtime} ${args.join(" ")})…`);
    // stdio inherited: a five-minute install with no output reads as a hang, and the default 1 MB capture would
    // kill a noisy one outright.
    const [code, signal] = (await once(
      spawn(runtime === "bun" ? "bun" : "npm", args, { cwd: agentDir, stdio: "inherit" }),
      "exit",
    )) as [number | null, NodeJS.Signals | null];
    if (code !== 0) throw new Error(`dependency install failed (${signal ?? `exit ${code}`})`);
    await rm(installing);
  }
}
