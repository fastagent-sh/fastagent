/**
 * What a deploy's BUILD CONTEXT (the agent directory) holds that must not ship, and whether an ignore file the author
 * kept still keeps it out. A kept `.dockerignore` silently replaces the generated one's protections, so the pre-flight
 * asks it the same questions the generated one answers by construction.
 */
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { isAbsolute, relative, join, sep } from "node:path";
import ignore from "ignore";
import {
  AGENT_CONFIG_FILE,
  SECRETS_DIRNAME,
  exists,
  readTextIfExists,
  resolveContextsDir,
  resolveSecretsDir,
  resolveStateRoot,
} from "../paths.ts";
import { isGeneratedDockerignore } from "./container.ts";
import type { DeployReport } from "./preflight.ts";

/**
 * "Would docker's packer drop this path?" — built from a `.dockerignore`'s text via the `ignore` matcher (the same
 * library the scaffolded ignore files use), so `!` negation and last-match-wins are the library's problem, not ours.
 */
function dockerignoreMatcher(text: string): (path: string) => boolean {
  const anchored = text
    .split("\n")
    .map((raw) => {
      const line = raw.trim();
      if (line === "" || line.startsWith("#")) return line;
      const negated = line.startsWith("!");
      const pattern = negated ? line.slice(1) : line;
      if (pattern.startsWith("/") || pattern.startsWith("**/")) return line;
      return `${negated ? "!" : ""}/${pattern}`;
    })
    .join("\n");
  const matcher = ignore({ ignorecase: false }).add(anchored);
  return (path) => matcher.ignores(path);
}

/**
 * A directory's entries, or none when it does not exist. Any other failure throws: the leak scan would otherwise pass
 * on a directory it never read, and a credential inside it would ship without a word.
 */
async function entriesIfExists(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`cannot read ${path} to check what the image would ship: ${(error as Error).message}`);
  }
}

/** Agent-dir-relative paths the build context may hold and the image must not. */
export interface BuildContextPaths {
  /** The resolved machinery dirs the generated ignore excludes by path (ContainerInput.machineryPaths). */
  machineryPaths: string[];
  /** Credential files that exist right now — a kept ignore file that lets one through bakes it. */
  leakCandidates: string[];
  /** The state root, when it exists inside the context. */
  stateShips?: string;
  /** The clones of the agent's github contexts, when they exist inside the context. */
  clonesShip?: string;
  /** The agent's node_modules, when it exists. */
  depDirs: string[];
}

export async function buildContextPaths(agentDir: string, authPath: string): Promise<BuildContextPaths> {
  const inContext = (p: string): string | undefined => {
    const rel = relative(agentDir, p);
    return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? undefined : rel.split(sep).join("/");
  };
  // The secrets DIR is the unit of RESPONSIBILITY, but never the unit of the leak QUESTION below.
  const secretsRel = inContext(resolveSecretsDir(agentDir));
  const authRel = inContext(authPath);
  const authElsewhere = authRel !== undefined && (secretsRel === undefined || !authRel.startsWith(`${secretsRel}/`));
  const secretsDirs = [SECRETS_DIRNAME];
  if (secretsRel && secretsRel !== SECRETS_DIRNAME && !secretsRel.startsWith(`${SECRETS_DIRNAME}/`)) {
    secretsDirs.push(secretsRel);
  }
  const secretPaths = [...secretsDirs, ...(authElsewhere ? [authRel] : [])];
  // ONE rule for every checked path: a file that is not there cannot be baked, so gating on it would be a refusal
  // about a spelling rather than about what would ship (an agent that has never run `login` has no auth.json).
  const present = async (rels: string[]): Promise<string[]> => {
    const found: string[] = [];
    for (const rel of rels) if (await exists(join(agentDir, rel))) found.push(rel);
    return found;
  };
  // State gets the same treatment (a custom in-tree FASTAGENT_STATE_DIR is invisible to the name-based `**/.state`),
  // at warn level.
  const stateRel = inContext(resolveStateRoot(agentDir));
  // Existence gates the WARNING, never the generated exclude (same split as secretPaths vs leakCandidates).
  const stateShips = stateRel !== undefined && (await exists(join(agentDir, stateRel))) ? stateRel : undefined;
  const clonesRel = inContext(resolveContextsDir(agentDir));
  const clonesShip = clonesRel !== undefined && (await exists(join(agentDir, clonesRel))) ? clonesRel : undefined;
  // The `.env` family at the level fastagent is RESPONSIBLE for: the agent dir's root.
  const envFiles = (await entriesIfExists(agentDir))
    .map((entry) => entry.name)
    .filter((n) => (n === ".env" || n.startsWith(".env.")) && n !== ".env.example");
  // Everything ACTUALLY inside the secrets dir, minus the two tracked scaffolds the image ships on purpose (they
  // carry no values; the generated ignore re-includes them by name).
  const secretDirFiles = async (dirRel: string): Promise<string[]> => {
    const entries = await entriesIfExists(join(agentDir, dirRel));
    const files: string[] = [];
    for (const entry of entries) {
      if (entry.name === ".gitignore" || entry.name === ".env.example") continue;
      if (entry.isDirectory()) files.push(...(await secretDirFiles(`${dirRel}/${entry.name}`)));
      else files.push(`${dirRel}/${entry.name}`);
    }
    return files;
  };
  const leakCandidates = [
    ...(await Promise.all(secretsDirs.map(secretDirFiles))).flat(),
    ...(await present(authElsewhere && authRel !== undefined ? [authRel] : [])),
    ...envFiles,
  ];
  // Same existence rule: a node_modules that is not there cannot be uploaded.
  const depDirs = await present(["node_modules"]);
  const machineryPaths = [...secretPaths, ...(stateRel ? [stateRel] : []), ...(clonesRel ? [clonesRel] : [])];
  return { machineryPaths, leakCandidates, stateShips, clonesShip, depDirs };
}

/** Interrogate BOTH ignore files deploy emits, when the author kept them. */
export async function checkKeptIgnoreFiles(
  ctx: { agentDir: string; force: boolean; paths: BuildContextPaths },
  report: DeployReport,
): Promise<void> {
  const { agentDir, force } = ctx;
  const { leakCandidates, stateShips, clonesShip, depDirs } = ctx.paths;
  for (const rel of [".dockerignore", "Dockerfile.dockerignore"]) {
    const kept = await readTextIfExists(join(agentDir, rel));
    if (kept === undefined) continue;
    // One WE generated is regenerated by this very run under --force, so checking the stale content on disk would
    // gate a deploy on a file about to be replaced.
    const keptIsOurs = isGeneratedDockerignore(kept);
    if (force && keptIsOurs) continue;
    const remedy = (lines: string[]): string =>
      keptIsOurs
        ? `Re-run with --force to regenerate it.`
        : `Add ${lines.map((p) => `\`${p}\``).join(" and ")} before deploying (the same lines the generated ${rel} writes).`;
    const excluded = dockerignoreMatcher(kept);
    // The marker of an agent: without it the deployed box has no agent to open.
    if (excluded(AGENT_CONFIG_FILE)) {
      const text =
        `your ${rel} (kept) excludes \`${AGENT_CONFIG_FILE}\` — the image would ship WITHOUT the agent's ` +
        `config (the deployed box has no agent to open and crash-loops). Remove that rule before deploying.`;
      report.issue(text);
    }
    // Resolved paths, not spellings: dockerignore patterns are root-anchored (unlike .gitignore).
    const leaks = leakCandidates.filter((p) => !excluded(p));
    if (leaks.length > 0) {
      const text =
        `your ${rel} (kept) does not exclude ${leaks.map((p) => `\`${p}\``).join(", ")} — the build ` +
        `context would BAKE SECRETS INTO THE IMAGE. ${remedy(leaks.map((p) => `/${p}`))}`;
      report.issue(text);
    }
    if (stateShips && !excluded(`${stateShips}/sessions`)) {
      report.warn(
        `your ${rel} (kept) does not exclude \`${stateShips}\` — the build machine's sessions/channel state would ship in the image. ${remedy([`/${stateShips}`])}`,
      );
    }
    if (clonesShip && !excluded(`${clonesShip}/x`)) {
      report.warn(
        `your ${rel} (kept) does not exclude \`${clonesShip}\` — the build machine's clones of the agent's github contexts would ship in the image. ${remedy([`/${clonesShip}`])}`,
      );
    }
    const unexcludedDeps = depDirs.filter((p) => !excluded(`${p}/.package-lock.json`));
    if (unexcludedDeps.length > 0) {
      report.warn(
        `your ${rel} does not exclude ${unexcludedDeps.map((p) => `\`${p}\``).join(" or ")} — the ` +
          `build machine's deps (native binaries for YOUR OS) would be uploaded and clobber the image's ` +
          `freshly-installed ones. ${remedy(unexcludedDeps.map((p) => `/${p}`))}`,
      );
    }
    if (excluded(".git/HEAD")) {
      report.note(
        `your ${rel} excludes .git — the baked definition ships WITHOUT its history (remove the .git line ` +
          `to ship it).`,
      );
    }
  }
}
