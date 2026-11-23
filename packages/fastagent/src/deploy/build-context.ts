/**
 * What the image's BUILD CONTEXT (the agent directory) holds that must not ship, and whether an ignore file the author
 * kept still keeps it out. A kept `.dockerignore` silently replaces the generated one's protections, so the pre-flight
 * asks it the same questions the generated one answers by construction.
 */
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { isAbsolute, relative, join, sep } from "node:path";
import ignore from "ignore";
import {
  AGENT_CONFIG_FILE,
  INSTANCES_DIRNAME,
  SECRETS_DIRNAME,
  exists,
  readTextIfExists,
  resolveSecretsDir,
  resolveStateRoot,
} from "../paths.ts";
import { isGeneratedDockerignore } from "./container.ts";
import type { DeployMessage, DeployReport } from "./preflight.ts";

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
  readonly machineryPaths: readonly string[];
  /** Credential files that exist right now — a kept ignore file that lets one through bakes it. */
  readonly leakCandidates: readonly string[];
  /** A state root of the agent's own choosing inside the context, when it exists. */
  readonly stateShips?: string;
  /** `.fastagent/`, when it exists: the local instances' state and clones, and a build's staging. */
  readonly instancesShip?: string;
  /** The agent's node_modules, when it exists. */
  readonly depDirs: readonly string[];
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
  const secretsDirs = [
    SECRETS_DIRNAME,
    ...(secretsRel && secretsRel !== SECRETS_DIRNAME && !secretsRel.startsWith(`${SECRETS_DIRNAME}/`)
      ? [secretsRel]
      : []),
  ];
  const secretPaths = [...secretsDirs, ...(authElsewhere ? [authRel] : [])];
  // ONE rule for every checked path: a file that is not there cannot be baked, so gating on it would be a refusal
  // about a spelling rather than about what would ship (an agent that has never run `login` has no auth.json).
  const present = async (rels: readonly string[]): Promise<string[]> =>
    (await Promise.all(rels.map(async (rel) => ((await exists(join(agentDir, rel))) ? [rel] : [])))).flat();
  // State gets the same treatment (an in-tree FASTAGENT_ROOT is not covered by the name-based rules), at warn level.
  const stateRel = inContext(resolveStateRoot(agentDir));
  const inInstances =
    stateRel !== undefined && (stateRel === INSTANCES_DIRNAME || stateRel.startsWith(`${INSTANCES_DIRNAME}/`));
  // Existence gates the WARNING, never the generated exclude (same split as secretPaths vs leakCandidates).
  const stateShips =
    stateRel !== undefined && !inInstances && (await exists(join(agentDir, stateRel))) ? stateRel : undefined;
  const instancesShip = (await exists(join(agentDir, INSTANCES_DIRNAME))) ? INSTANCES_DIRNAME : undefined;
  // The value files at the level fastagent is RESPONSIBLE for, the agent dir's root: the `.env` family, and a file a
  // person named for its values (`prod.env`).
  const envFiles = (await entriesIfExists(agentDir))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((n) => (n === ".env" || n.startsWith(".env.") || n.endsWith(".env")) && n !== ".env.example");
  // Everything ACTUALLY inside the secrets dir, minus the two tracked scaffolds the image ships on purpose (they
  // carry no values; the generated ignore re-includes them by name).
  const secretDirFiles = async (dirRel: string): Promise<string[]> => {
    const entries = await entriesIfExists(join(agentDir, dirRel));
    const nested = await Promise.all(
      entries
        .filter((entry) => entry.name !== ".gitignore" && entry.name !== ".env.example")
        .map((entry) =>
          entry.isDirectory()
            ? secretDirFiles(`${dirRel}/${entry.name}`)
            : Promise.resolve([`${dirRel}/${entry.name}`]),
        ),
    );
    return nested.flat();
  };
  const leakCandidates = [
    ...(await Promise.all(secretsDirs.map(secretDirFiles))).flat(),
    ...(await present(authElsewhere && authRel !== undefined ? [authRel] : [])),
    ...envFiles,
  ];
  // Same existence rule: a node_modules that is not there cannot be uploaded.
  const depDirs = await present(["node_modules"]);
  const machineryPaths = [...secretPaths, ...(stateRel && !inInstances ? [stateRel] : [])];
  return { machineryPaths, leakCandidates, stateShips, instancesShip, depDirs };
}

/** The ignore files Docker reads for the generated Dockerfile: the one beside it first, then the context's. */
const IGNORE_FILES = [".dockerignore", "Dockerfile.dockerignore"];

/**
 * What would leave the machine of its secrets and state when the context has no `.dockerignore`, so leaves out nothing;
 * undefined when it has one, or nothing to leave out. Only `.dockerignore` counts: it is what every uploader of a
 * context reads (AgentCore's CDK packs a context for CodeBuild by it), while `Dockerfile.dockerignore` only keeps a
 * path out of the image Docker builds, not out of the upload.
 */
/** Pure leak message for a build context missing `.dockerignore`. */
function formatShippedWithoutIgnore(paths: Readonly<BuildContextPaths>): string | undefined {
  const shipped = [
    ...paths.leakCandidates,
    ...(paths.stateShips === undefined ? [] : [paths.stateShips]),
    ...(paths.instancesShip === undefined ? [] : [paths.instancesShip]),
  ];
  if (shipped.length === 0) return undefined;
  return (
    `there is no .dockerignore, so the build would upload ${shipped.map((p) => `\`${p}\``).join(", ")}: this ` +
    `machine's secrets and state. Add one that leaves them out, as the generated .dockerignore does.`
  );
}

export async function shippedWithoutIgnoreFile(
  agentDir: string,
  paths: Readonly<BuildContextPaths>,
): Promise<string | undefined> {
  if (await exists(join(agentDir, ".dockerignore"))) return undefined;
  return formatShippedWithoutIgnore(paths);
}

/** Pure evaluation of one kept ignore file against the build context's sensitive paths. */
function evaluateKeptIgnore(rel: string, kept: string, paths: Readonly<BuildContextPaths>): readonly DeployMessage[] {
  const { leakCandidates, stateShips, instancesShip, depDirs } = paths;
  const keptIsOurs = isGeneratedDockerignore(kept);
  const remedy = (lines: readonly string[]): string =>
    keptIsOurs
      ? `Re-run with --force to regenerate it.`
      : `Add ${lines.map((p) => `\`${p}\``).join(" and ")} before building (the same lines the generated ${rel} writes).`;
  const excluded = dockerignoreMatcher(kept);
  const leaks = leakCandidates.filter((p) => !excluded(p));
  const unexcludedDeps = depDirs.filter((p) => !excluded(`${p}/.package-lock.json`));
  return [
    // The marker of an agent: without it the deployed box has no agent to open.
    ...(excluded(AGENT_CONFIG_FILE)
      ? [
          {
            level: "warn" as const,
            text:
              `your ${rel} (kept) excludes \`${AGENT_CONFIG_FILE}\` — the image would ship WITHOUT the agent's ` +
              `config (the container has no agent to open and crash-loops). Remove that rule before building.`,
          },
        ]
      : []),
    // Resolved paths, not spellings: dockerignore patterns are root-anchored (unlike .gitignore).
    ...(leaks.length > 0
      ? [
          {
            level: "leak" as const,
            text:
              `your ${rel} (kept) does not exclude ${leaks.map((p) => `\`${p}\``).join(", ")} — the build ` +
              `context would BAKE SECRETS INTO THE IMAGE. ${remedy(leaks.map((p) => `/${p}`))}`,
          },
        ]
      : []),
    ...(stateShips && !excluded(`${stateShips}/sessions`)
      ? [
          {
            level: "leak" as const,
            text: `your ${rel} (kept) does not exclude \`${stateShips}\` — the build machine's sessions and state would ship in the image. ${remedy([`/${stateShips}`])}`,
          },
        ]
      : []),
    ...(instancesShip && !excluded(`${instancesShip}/dev/.state/x`)
      ? [
          {
            level: "leak" as const,
            text: `your ${rel} (kept) does not exclude \`${instancesShip}\` — the build machine's sessions and state would ship in the image. ${remedy([`/${instancesShip}`])}`,
          },
        ]
      : []),
    ...(unexcludedDeps.length > 0
      ? [
          {
            level: "warn" as const,
            text:
              `your ${rel} does not exclude ${unexcludedDeps.map((p) => `\`${p}\``).join(" or ")} — the ` +
              `build machine's deps (native binaries for YOUR OS) would be uploaded and clobber the image's ` +
              `freshly-installed ones. ${remedy(unexcludedDeps.map((p) => `/${p}`))}`,
          },
        ]
      : []),
    ...(excluded(".git/HEAD")
      ? [
          {
            level: "note" as const,
            text:
              `your ${rel} excludes .git — the baked definition ships WITHOUT its history (remove the .git line ` +
              `to ship it).`,
          },
        ]
      : []),
  ];
}

/** Interrogate the ignore files Docker reads, when the author kept them. */
export async function checkKeptIgnoreFiles(
  ctx: { readonly agentDir: string; readonly force: boolean; readonly paths: Readonly<BuildContextPaths> },
  report: DeployReport,
): Promise<void> {
  const { agentDir, force, paths } = ctx;
  for (const rel of IGNORE_FILES) {
    const kept = await readTextIfExists(join(agentDir, rel));
    if (kept === undefined) continue;
    // One WE generated is regenerated by this very run under --force, so checking the stale content on disk would
    // gate a deploy on a file about to be replaced.
    if (force && isGeneratedDockerignore(kept)) continue;
    for (const message of evaluateKeptIgnore(rel, kept, paths)) {
      report[message.level](message.text);
    }
  }
}
