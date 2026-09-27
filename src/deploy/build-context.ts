/**
 * What a deploy's BUILD CONTEXT (the workspace) holds that must not ship, and whether an ignore file the author kept
 * still keeps it out. A kept workspace-root `.dockerignore` silently replaces the generated one's protections, so the
 * pre-flight asks it the same questions the generated one answers by construction.
 */
import { readdir } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import ignore from "ignore";
import { exists, readTextIfExists, resolveSecretsDir, resolveStateRoot } from "../paths.ts";
import { isGeneratedDockerignore } from "./container.ts";
import type { DeployReport } from "./preflight.ts";

/**
 * "Would docker's packer drop this path?" — built from a `.dockerignore`'s text via the `ignore` matcher (the same
 * library the workspace ignore files use), so `!` negation and last-match-wins are the library's problem, not ours.
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

/** Workspace-relative paths the build context may hold and the image must not. */
export interface BuildContextPaths {
  /** The resolved machinery dirs the generated ignore excludes by path (ContainerInput.machineryPaths). */
  machineryPaths: string[];
  /** Credential files that exist right now — a kept ignore file that lets one through bakes it. */
  leakCandidates: string[];
  /** The state root, when it exists inside the context. */
  stateShips?: string;
  /** The node_modules dirs that exist, the agent's and the workspace's. */
  depDirs: string[];
}

export async function buildContextPaths(
  workspace: string,
  agentDir: string,
  agentPrefix: string,
  authPath: string,
): Promise<BuildContextPaths> {
  const inContext = (p: string): string | undefined => {
    const rel = relative(workspace, p);
    return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? undefined : rel.split(sep).join("/");
  };
  // The secrets DIR is the unit of RESPONSIBILITY, but never the unit of the leak QUESTION below.
  const secretsRel = inContext(resolveSecretsDir(agentDir));
  const authRel = inContext(authPath);
  const authElsewhere = authRel !== undefined && (secretsRel === undefined || !authRel.startsWith(`${secretsRel}/`));
  const secretPaths = [...(secretsRel ? [secretsRel] : []), ...(authElsewhere ? [authRel] : [])];
  // ONE rule for every checked path: a file that is not there cannot be baked, so gating on it would be a refusal
  // about a spelling rather than about what would ship (an agent that has never run `login` has no auth.json).
  const present = async (rels: string[]): Promise<string[]> => {
    const found: string[] = [];
    for (const rel of rels) if (await exists(join(workspace, rel))) found.push(rel);
    return found;
  };
  // State gets the same treatment (a custom in-tree FASTAGENT_STATE_DIR is invisible to the name-based `**/.state`),
  // at warn level.
  const stateRel = inContext(resolveStateRoot(agentDir));
  // Existence gates the WARNING, never the generated exclude (same split as secretPaths vs leakCandidates).
  const stateShips = stateRel !== undefined && (await exists(join(workspace, stateRel))) ? stateRel : undefined;
  // The `.env` family at the two levels fastagent is RESPONSIBLE for: the agent dir and the workspace root.
  const dotEnvFiles = async (relDir: string): Promise<string[]> => {
    const names = await readdir(join(workspace, relDir || ".")).catch(() => [] as string[]);
    // POSIX separators, like every other context-relative path here (`inContext`).
    return names
      .filter((n) => (n === ".env" || n.startsWith(".env.")) && n !== ".env.example")
      .map((n) => join(relDir, n).split(sep).join("/"));
  };
  const envFiles = (await Promise.all([...new Set(["", agentPrefix])].map(dotEnvFiles))).flat();
  // Everything ACTUALLY inside the secrets dir, minus the two tracked scaffolds the image ships on purpose (they
  // carry no values; the generated ignore re-includes them by name).
  const secretDirFiles = async (dirRel: string): Promise<string[]> => {
    const entries = await readdir(join(workspace, dirRel), { withFileTypes: true }).catch(() => []);
    const files: string[] = [];
    for (const entry of entries) {
      if (entry.name === ".gitignore" || entry.name === ".env.example") continue;
      if (entry.isDirectory()) files.push(...(await secretDirFiles(`${dirRel}/${entry.name}`)));
      else files.push(`${dirRel}/${entry.name}`);
    }
    return files;
  };
  const leakCandidates = [
    ...(secretsRel ? await secretDirFiles(secretsRel) : []),
    ...(await present(authElsewhere && authRel !== undefined ? [authRel] : [])),
    ...envFiles,
  ];
  // Same existence rule: a node_modules that is not there cannot be uploaded.
  const depDirs = await present([...new Set([`${agentPrefix}node_modules`, "node_modules"])]);
  const machineryPaths = [...secretPaths, ...(stateRel ? [stateRel] : [])];
  return { machineryPaths, leakCandidates, stateShips, depDirs };
}

/** Interrogate BOTH ignore files deploy emits, when the author kept them. */
export async function checkKeptIgnoreFiles(
  ctx: { workspace: string; agentDir: string; agentPrefix: string; force: boolean; paths: BuildContextPaths },
  report: DeployReport,
): Promise<void> {
  const { workspace, agentDir, agentPrefix, force } = ctx;
  const { leakCandidates, stateShips, depDirs } = ctx.paths;
  for (const rel of [".dockerignore", `${agentPrefix}Dockerfile.dockerignore`]) {
    const kept = await readTextIfExists(join(workspace, rel));
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
    // Asked as a DIRECTORY (trailing slash), which is what it is.
    if (excluded(`${basename(agentDir)}/`)) {
      const text =
        `your ${rel} (kept) excludes \`${basename(agentDir)}\` — the build context would ship WITHOUT the ` +
        `agent entirely (the deployed box has no persona/config and crash-loops). Remove that rule ` +
        `before deploying.`;
      report.issue(text);
    }
    // Resolved paths, not spellings: dockerignore patterns are root-anchored (unlike .gitignore), so a bare
    // `.secrets` line does not cover `fastagent/.secrets`.
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
    // Both the agent's own node_modules and the workspace's.
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
        `your ${rel} excludes .git — the baked copy ships WITHOUT history/remote, so the agent ` +
          `cannot pull/commit/push it; it must \`git clone\` its repo in the workspace instead (or remove the .git line).`,
      );
    }
  }
}
