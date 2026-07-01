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
import { realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ExecutionEnv, Skill, SkillDiagnostic } from "@earendil-works/pi-agent-core";
import { loadSkills } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { projectStateDir } from "./config.ts";

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
 * Whether `targetPath` lives inside `stateDir` (the in-tree `<dir>/.fastagent`). This — not "was an
 * option passed" — is the test that drives self-ignore: ANY state/secret landing under `.fastagent`
 * (a defaulted path, or an explicit `--sessions-dir`/`--auth-path` pointed back in-tree) must be
 * ignored; a path on an external volume must not (and we never write our `.gitignore` outside the
 * tree anyway). Same path → true; the stateDir is always ours to write into.
 */
export function isUnderStateDir(targetPath: string, stateDir: string): boolean {
  const rel = relative(stateDir, targetPath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Self-ignore a `.fastagent` state dir: create it if missing, then write `<stateDir>/.gitignore` = "*"
 * (idempotent — an existing one is kept), so a workspace that runs dev/start never shows machine state
 * as untracked. Creates the dir because a caller may self-ignore it before anything else populates it
 * (e.g. `login` writing auth.json, or the default sessions store pointing elsewhere on a volume).
 *
 * Module-PRIVATE on purpose: the only entry to the leak guard is {@link ensureInTreeStateSelfIgnored}
 * (home exclusion + containment). Keeping this unexported makes that single-owner claim hold at the
 * type level — a sibling command can't bypass those checks by writing a `.gitignore` directly.
 */
async function ensureStateDirSelfIgnored(stateDir: string): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, ".gitignore"), "*\n", { flag: "wx" }).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "EEXIST") throw e;
  });
}

/**
 * The single owner of the self-ignore MECHANISM: if any of `paths` lands inside `<dir>/.fastagent`,
 * write that dir's `.gitignore="*"` (which then covers EVERYTHING under `.fastagent` — sessions,
 * auth.json, a channel's downloads). The orchestration (derive stateDir → test → ensure, with the home
 * exclusion below) lives here, and `ensureStateDirSelfIgnored` is private, so a caller cannot write a
 * `.gitignore` bypassing these checks.
 *
 * It is NOT auto-discovery: it fires only for the `paths` it is GIVEN. Every command/channel that puts
 * state in-tree must register its path here (the opener: sessions + auth; `login`: auth). A path it is
 * never told about is covered only incidentally — e.g. `<cwd>/.fastagent/telegram-files` relies on the
 * opener having self-ignored `.fastagent` for sessions/auth, so an all-external sessions+auth config
 * would leave it untracked-but-committable (a channel that wants a guarantee must register its dir).
 *
 * Excludes the user's HOME-global `~/.fastagent` (e.g. `login`/`dev` run from `$HOME`): self-ignore is
 * for protecting state inside an agent PROJECT tree, not for writing a `.gitignore` into the user's
 * home, which a dotfiles repo may track. The global credential file there was never self-ignored.
 */
export async function ensureInTreeStateSelfIgnored(dir: string, ...paths: string[]): Promise<void> {
  // Compare CANONICAL paths for the home check: `dir` arrives realpath-resolved (it is `process.cwd()`
  // or `resolve(".")`) but `homedir()` returns the raw `$HOME`, so a symlinked home would slip past raw
  // equality and we'd write a `.gitignore` into the real `~/.fastagent` — the very thing the doc forbids
  // (chat.ts canonicalizes for the same reason).
  if (canonicalPath(dir) === canonicalPath(homedir())) return;
  // Containment uses the RAW stateDir. For the DEFAULTED paths (the common case + the whole point of the
  // guard) auth/sessions derive from this same `dir`, so raw equality is correct by construction.
  // NOT covered: an explicit `--auth-path`/`--sessions-dir` given in a different symlink form than `dir`
  // (e.g. a realpath into a symlinked workspace) — canonicalizing wouldn't reliably fix it either, since
  // a not-yet-created `.fastagent`/auth.json can't be realpath'd. An operator supplying an explicit path
  // owns where it lands.
  const stateDir = projectStateDir(dir);
  if (paths.some((p) => isUnderStateDir(p, stateDir))) await ensureStateDirSelfIgnored(stateDir);
}

/** Resolve to a canonical (symlink-free) absolute path so comparisons match `process.cwd()`'s realpath.
 *  A non-existent path can't be realpath'd, so it stays as the plain absolute resolve. */
export function canonicalPath(p: string): string {
  const resolved = resolve(p);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}
