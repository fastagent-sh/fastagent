/**
 * Definition domain: read an agent definition folder (AGENTS.md + skills/) into memory. Produces
 * data; create.ts consumes it.
 *
 * IO policy: the runtime load path (loadAgentDefinition) does IO only through ExecutionEnv (portable
 * across local/sandbox/remote envs); the invoke path never touches disk. config/auth/sessions and
 * this module's Node helpers are composition-root code and may use node fs.
 *
 * Errors: ExecutionEnv returns Result; this module converts a broken definition to a throw (fail
 * loudly at startup), while non-fatal findings (bad skill files, name collisions) are returned as
 * data for the caller to surface.
 */
import { readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import ignore, { type Ignore } from "ignore";
import type { ExecutionEnv, Skill, SkillDiagnostic } from "@earendil-works/pi-agent-core";
import { loadSkills } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

/**
 * Refuse a workspace subdir (`channels/`, …) that resolves OUTSIDE the workspace via a symlink: an
 * escaping subdir puts part of the agent outside its own directory (a deploy that copies the dir
 * would miss it, and a write through it lands outside). An in-workspace symlink is fine; a missing
 * subdir is fine. Both ends are realpath'd so a symlinked root (/tmp → /private/tmp) is not a false escape.
 */
export async function assertInsideWorkspace(workspaceDir: string, name: string): Promise<void> {
  const target = join(workspaceDir, name);
  const real = await realpath(target).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT" || e.code === "not_found") return undefined;
    throw e;
  });
  if (real === undefined) return;
  const root = await realpath(workspaceDir).catch(() => resolve(workspaceDir));
  const rel = relative(root, real);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `${target} resolves outside the workspace (${real}) — it must live inside the definition directory; ` +
        `use a real directory or a symlink that stays within it`,
    );
  }
}

/** A same-name skill collision (the discarded side). Surfaced, never swallowed. */
export interface SkillCollision {
  name: string;
  winnerPath: string;
  loserPath: string;
}

/** Result of loading a definition folder. Produced by {@link loadAgentDefinition}. */
export interface LoadedDefinition {
  /** Verbatim AGENTS.md content (feeds prompt segment ②); undefined when the file does not exist. */
  instructions?: string;
  skills: Skill[];
  /** Non-fatal per-file skill problems reported by pi's loader. */
  diagnostics: SkillDiagnostic[];
  /** Same-name conflicts across mounts (first-wins). */
  collisions: SkillCollision[];
  /** Absolute definition folder path. AGENTS.md, when present, is at join(dir, "AGENTS.md"). */
  dir: string;
}

export interface LoadAgentDefinitionOptions {
  env?: ExecutionEnv;
}

/** Read a definition folder. env defaults to local Node (cwd=dir); non-local deployments inject their env. */
export async function loadAgentDefinition(
  dir: string,
  options: LoadAgentDefinitionOptions = {},
): Promise<LoadedDefinition> {
  const e = options.env ?? new NodeExecutionEnv({ cwd: dir });
  const rootResult = await e.absolutePath(dir);
  if (!rootResult.ok) {
    throw new Error(`cannot resolve definition dir "${dir}": ${rootResult.error.message}`);
  }
  const root = rootResult.value;

  const agentsPath = join(root, "AGENTS.md");
  const read = await e.readTextFile(agentsPath);
  // Only not_found means "no AGENTS.md". Anything else (permission, io) must surface, or the agent
  // silently runs without instructions.
  if (!read.ok && read.error.code !== "not_found") {
    throw new Error(`cannot read ${agentsPath}: ${read.error.message}`);
  }
  const instructions = read.ok ? read.value : undefined;

  // Skills come ONLY from the definition's own skills/ (no external/global mount), so the same
  // definition loads the same skills on every machine.
  const { skills: raw, diagnostics } = await loadSkills(e, [join(root, "skills")]);
  const byName = new Map<string, Skill>();
  const collisions: SkillCollision[] = [];
  for (const skill of raw) {
    const existing = byName.get(skill.name);
    if (existing) {
      collisions.push({ name: skill.name, winnerPath: existing.filePath, loserPath: skill.filePath });
    } else {
      byName.set(skill.name, skill);
    }
  }

  return { instructions, skills: [...byName.values()], diagnostics, collisions, dir: root };
}

/**
 * Self-ignore a `.fastagent` state dir: write `<stateDir>/.gitignore` = "*" (idempotent — an
 * existing one is kept), so a workspace that runs dev/start never shows machine state as untracked.
 */
export async function ensureStateDirSelfIgnored(stateDir: string): Promise<void> {
  await writeFile(join(stateDir, ".gitignore"), "*\n", { flag: "wx" }).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "EEXIST") throw e;
  });
}

/**
 * Load the root's exclude rules into ONE flat matcher: `.gitignore` then `.fastagentignore` (fa last
 * → authoritative on conflicts). Deliberately FLAT — only the ROOT files, not nested or ancestor
 * .gitignore; for finer control put rules in the root `.fastagentignore`. The `ignore` library
 * handles git's per-file pattern syntax. An unreadable file fails visibly.
 *
 * Exported (module-internal) so commands can ask whether a path is ignored — e.g. whether `.env`
 * would ship before advising where to keep a secret.
 */
export async function loadRootIgnore(dir: string): Promise<Ignore | undefined> {
  let rules = "";
  for (const name of [".gitignore", ".fastagentignore"]) {
    try {
      rules += `\n${await readFile(join(dir, name), "utf8")}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`cannot read ${join(dir, name)}: ${(error as Error).message}`);
      }
    }
  }
  // ignorecase:false — the library defaults to case-INSENSITIVE, which would make a rule `README.md`
  // also drop an authored `readme.md`. Match git on a case-sensitive filesystem, reproducibly.
  return rules.trim() === "" ? undefined : ignore({ ignorecase: false }).add(rules);
}
