/** `fastagent init [dir]`: create or initialize an agent directory and safely resume dependency installation. */
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { writeFileAtomic } from "../../atomic-write.ts";
import { INSTANCES_DIRNAME, displayPath, exists } from "../../paths.ts";
import { initRepository, scaffoldAgent } from "../../scaffold/init.ts";
import { expectedManifestDeps } from "../../scaffold/templates.ts";
import { fastagentBuild } from "../../version.ts";
import { failStartup } from "../fail.ts";

export interface InitOptions {
  /** false ⇔ `--no-install`. */
  install: boolean;
}

const PENDING_MARKER = join(INSTANCES_DIRNAME, "install-pending");

interface NpmLsEntry {
  name?: string;
  version?: string;
  path?: string;
  missing?: boolean;
  invalid?: string;
  peerMissing?: boolean;
  dependencies?: Record<string, NpmLsEntry>;
}

function retryCommand(dirArg: string): string {
  return dirArg === "." ? "fastagent init" : `fastagent init ${dirArg}`;
}

export async function runInit(dirArg = ".", opts: InitOptions = { install: true }): Promise<void> {
  const dir = resolve(dirArg);
  const result = await scaffoldAgent(dir).catch(failStartup);
  const build = await fastagentBuild();
  const deps = expectedManifestDeps(build);
  const requiredPackages = [...Object.keys(deps.dependencies), ...Object.keys(deps.devDependencies)];
  const pendingPath = join(dir, PENDING_MARKER);
  const hadPending = await exists(pendingPath);

  let installState: "installed" | "skipped" | "satisfied" = "skipped";
  if (opts.install) {
    const needInstall =
      hadPending || result.dependenciesChanged || !(await areDependenciesInstalled(dir, requiredPackages));
    if (needInstall) {
      writeFileAtomic(pendingPath, "pending\n");
      console.error("[fastagent] installing dependencies (npm install)…");
      const code = await npmInstall(dir);
      if (code !== 0) {
        reportTrackedSecrets(result.trackedSecrets);
        console.error(
          `[fastagent] Error: npm install failed (exit ${code}) — scaffold kept in ${dir}; fix the issue and re-run \`${retryCommand(dirArg)}\``,
        );
        process.exit(1);
      }
      await rm(pendingPath, { force: true });
      installState = "installed";
    } else {
      installState = "satisfied";
    }
  }

  const repository = result.mode === "fresh" ? await initRepository(dir, { mode: "fresh" }) : undefined;

  if (result.created.length === 0 && result.updated.length === 0 && installState === "satisfied") {
    console.error(`[fastagent] ${dir} is already ready (no changes)`);
    reportTrackedSecrets(result.trackedSecrets);
    return;
  }

  const heading = result.mode === "fresh" ? "created" : "initialized";
  console.error(`[fastagent] ${heading} ${dir}`);
  if (result.created.length > 0) console.error(`  created: ${result.created.join(", ")}`);
  if (result.updated.length > 0) console.error(`  updated: ${result.updated.join(", ")}`);
  if (result.preserved.length > 0) console.error(`  preserved: ${result.preserved.join(", ")}`);
  if (repository !== undefined) console.error(`[fastagent] git: ${repository}`);
  if (installState === "skipped") {
    console.error("[fastagent] dependencies: skipped (--no-install) — run `npm install` or re-run `fastagent init`");
  }
  reportTrackedSecrets(result.trackedSecrets);

  console.error("  next steps:");
  const cdTarget = displayPath(process.cwd(), dir);
  if (cdTarget) console.error(`    cd ${cdTarget}`);
  if (installState === "skipped") console.error("    npm install");
  if (result.mode === "existing") console.error("    fastagent info --json   # verify your skills and setup");
  console.error("    npm run dev   # serve locally and iterate");
}

function reportTrackedSecrets(trackedSecrets: readonly string[]): void {
  if (trackedSecrets.length === 0) return;
  console.error(
    `[fastagent] warn: already tracked in git (not protected by .gitignore): ${trackedSecrets.join(", ")} — untrack with \`git rm --cached ${trackedSecrets.join(" ")}\``,
  );
}

function findTargetChain(
  node: NpmLsEntry,
  targetRealPath: string,
  targetName: string | undefined,
): NpmLsEntry[] | undefined {
  if (typeof node.path === "string") {
    try {
      if (realpathSync(node.path) === targetRealPath) return [node];
    } catch {
      // Ignore vanished/unreadable paths in npm ls output.
    }
  }
  for (const child of Object.values(node.dependencies ?? {})) {
    if (typeof child !== "object" || child === null) continue;
    const found = findTargetChain(child, targetRealPath, targetName);
    if (found !== undefined) return [node, ...found];
  }
  if (node.path === undefined && targetName !== undefined && node.name === targetName) return [node];
  return undefined;
}

/** Check whether every required package is installed and valid for the target package (standalone or workspace). */
async function areDependenciesInstalled(dir: string, requiredPackages: readonly string[]): Promise<boolean> {
  let targetName: string | undefined;
  let targetRealPath: string;
  try {
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { name?: unknown };
    if (typeof pkg.name === "string") targetName = pkg.name;
    targetRealPath = realpathSync(dir);
  } catch {
    return false;
  }

  const output = await npmLsJson(dir);
  if (output === undefined) return false;
  let tree: NpmLsEntry;
  try {
    tree = JSON.parse(output) as NpmLsEntry;
  } catch {
    return false;
  }
  const chain = findTargetChain(tree, targetRealPath, targetName);
  if (chain === undefined || chain.length === 0) return false;

  const target = chain[chain.length - 1] as NpmLsEntry;
  for (const pkgName of requiredPackages) {
    const direct = target.dependencies?.[pkgName];
    if (direct !== undefined) {
      if (direct.missing === true || direct.invalid !== undefined || direct.peerMissing === true) return false;
      if (typeof direct.version !== "string") return false;
      continue;
    }
    // Allow packages hoisted to a workspace ancestor.
    let satisfiedByAncestor = false;
    for (let i = chain.length - 2; i >= 0; i--) {
      const ancestorEntry = chain[i]?.dependencies?.[pkgName];
      if (ancestorEntry === undefined) continue;
      if (
        ancestorEntry.missing === true ||
        ancestorEntry.invalid !== undefined ||
        ancestorEntry.peerMissing === true ||
        typeof ancestorEntry.version !== "string"
      ) {
        return false;
      }
      satisfiedByAncestor = true;
      break;
    }
    if (!satisfiedByAncestor) return false;
  }
  return true;
}

function npmLsJson(cwd: string): Promise<string | undefined> {
  return new Promise((resolveOut) => {
    const child = spawn("npm", ["ls", "--depth=0", "--include=dev", "--long", "--json"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("close", () => resolveOut(stdout.trim() === "" ? undefined : stdout));
    child.on("error", () => resolveOut(undefined));
  });
}

/** Run `npm install` in `cwd`, keeping progress output on stderr so stdout stays clean. */
function npmInstall(cwd: string): Promise<number> {
  return new Promise((resolveCode) => {
    const child = spawn("npm", ["install"], { cwd, stdio: ["inherit", "pipe", "pipe"] });
    child.stdout?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    child.on("close", (code) => resolveCode(code ?? 1));
    child.on("error", () => resolveCode(1));
  });
}
