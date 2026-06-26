/**
 * Definition domain: read an agent definition folder (AGENTS.md + skills/) into
 * memory. No dependency on agent creation — this module produces data; create.ts
 * consumes it.
 *
 * Domain note: the definition CONCEPT is engine-neutral (AGENTS.md / agentskills
 * are cross-product standards — the definition is input to a harness, never part
 * of it). This IMPLEMENTATION is pi-folded (pi's loadSkills / Skill types) per the
 * folded-M decision; lift it out of engines/pi when engine #2 lands.
 *
 * IO policy (the precise form of the "core does not read disk" invariant):
 *   - the runtime load path (loadAgentDefinition) does IO **only through ExecutionEnv**
 *     (portable: local / sandbox / remote envs);
 *   - the invoke path (invoke.ts/harness.ts) never touches the disk itself;
 *   - config.ts / auth.ts / sessions.ts (and create.ts's L3 workspace-state setup)
 *     are Node composition-root code and may use node fs.
 *
 * Error conventions on this path:
 *   - ExecutionEnv layer returns Result (pi's contract);
 *   - this module converts Results to **throws** (a broken definition should fail
 *     loudly at startup, not at first invoke);
 *   - non-fatal load findings (bad skill files, name collisions) are returned as
 *     data (diagnostics/collisions) for the caller to surface — visible, not fatal.
 */
import { readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import ignore, { type Ignore } from "ignore";
import type { ExecutionEnv, Skill, SkillDiagnostic } from "@earendil-works/pi-agent-core";
import { loadSkills } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

/**
 * Refuse a workspace subdir (`channels/`, …) that resolves OUTSIDE the workspace via a symlink. Part
 * of "the directory is the agent": an escaping subdir puts part of the agent outside its own directory
 * — a deploy that copies the dir would not include it (dev/deployed diverge), and a write through it
 * lands outside the workspace. An IN-workspace symlink is self-contained and allowed; a missing subdir
 * is fine. Both ends are realpath'd so a symlinked workspace root (/tmp → /private/tmp) is not a false escape.
 */
export async function assertInsideWorkspace(workspaceDir: string, name: string): Promise<void> {
  const target = join(workspaceDir, name);
  const real = await realpath(target).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT" || e.code === "not_found") return undefined; // not there yet — nothing to check
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

/** A same-name skill collision (the discarded side). Must surface, never swallowed (fail visibly). */
export interface SkillCollision {
  name: string;
  winnerPath: string;
  loserPath: string;
}

/**
 * Result of loading a definition folder. Produced by {@link loadAgentDefinition};
 * never hand-authored — the authored definition is the folder itself.
 */
export interface LoadedDefinition {
  /** Verbatim AGENTS.md content (feeds prompt segment ②); undefined when the file does not exist. */
  instructions?: string;
  skills: Skill[];
  /** Non-fatal per-file skill problems reported by pi's loader (skill skipped, reason recorded). */
  diagnostics: SkillDiagnostic[];
  /** Same-name conflicts across mounts (first-wins; definition-local wins). */
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
    // No silent fallback: a failing absolutePath means the env itself is broken.
    throw new Error(`cannot resolve definition dir "${dir}": ${rootResult.error.message}`);
  }
  const root = rootResult.value;

  const agentsPath = join(root, "AGENTS.md");
  const read = await e.readTextFile(agentsPath);
  // Only not_found means "no AGENTS.md". Anything else (permission, io) must surface,
  // otherwise the agent silently runs without instructions (AGENTS.md rule 8).
  if (!read.ok && read.error.code !== "not_found") {
    throw new Error(`cannot read ${agentsPath}: ${read.error.message}`);
  }
  const instructions = read.ok ? read.value : undefined;

  // Skills come ONLY from the definition's own skills/ — your folder is the agent, with
  // no external/global mount, so the same definition loads the same skills on every machine.
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

  return {
    instructions,
    skills: [...byName.values()],
    diagnostics,
    collisions,
    dir: root,
  };
}

/**
 * Self-ignore a `.fastagent` state dir: write `<stateDir>/.gitignore` = "*" (idempotent —
 * an existing one is kept). Machine state (runtime sessions) is gitignored, deletable, and
 * rebuildable, so a workspace that runs dev/start never shows it as untracked. The caller
 * creates the dir; this only drops the marker.
 */
export async function ensureStateDirSelfIgnored(stateDir: string): Promise<void> {
  await writeFile(join(stateDir, ".gitignore"), "*\n", { flag: "wx" }).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "EEXIST") throw e;
  });
}

/**
 * Load the root's exclude rules into ONE flat matcher: `.gitignore` then
 * `.fastagentignore` (fa last → authoritative on conflicts), applied relative to the tree
 * root. Deliberately FLAT — we read only the ROOT files, not nested .gitignore
 * down the tree and not ancestor .gitignore up a monorepo. Reproducing git's full nested +
 * ancestor + repo-boundary ignore engine by hand is an open-ended edge factory (it was);
 * the contract is simply "hard excludes + your root .gitignore/.fastagentignore". For
 * finer or monorepo-package control, put rules in the root `.fastagentignore`. The single
 * `ignore` library matcher handles git's PER-FILE pattern syntax (negation, anchoring,
 * `**`, dir-slash) faithfully — that part is not hand-rolled.
 *
 * An existing-but-unreadable file fails visibly — silently building with no rules could
 * ship files the author meant to exclude.
 *
 * Exported (module-internal, not on the public surface) so commands can ask whether a path is
 * ignored — e.g. `init` and `add github` check whether `.env` is gitignored before advising
 * where to keep a secret.
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
  // ignorecase:false — the `ignore` library defaults to case-INSENSITIVE, which would make a
  // rule `README.md` also drop an authored `readme.md`. Match git on a case-sensitive
  // filesystem (our main deploy target) and stay reproducible (a fixed mode, not FS-derived).
  return rules.trim() === "" ? undefined : ignore({ ignorecase: false }).add(rules);
}
