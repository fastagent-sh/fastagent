/**
 * Definition domain: read an agent definition directory (AGENTS.md + skills/) into memory. Produces
 * data; create.ts consumes it.
 *
 * IO policy: persona.md + skills load through ExecutionEnv (portable across local/sandbox/remote); the
 * invoke path never touches disk. EXCEPTION — ② project context comes from pi's loadProjectContextFiles,
 * which reads via node fs DIRECTLY (not the injected `env`) and, on failure, at best warns to stderr and
 * at worst is fully silent (its `existsSync` probe swallows a permission error) — no structured signal. So under a
 * non-local ExecutionEnv the ② files still resolve against THIS process's filesystem, not the target env
 * — a known break in the portability contract, deferred with the sandbox work (core.md §6). config/auth/
 * sessions and this module's Node helpers are composition-root code and may use node fs.
 *
 * Errors: a broken persona.md / unresolvable dir throws (fail loudly at startup); non-fatal findings
 * (bad skill files, name collisions) are returned as data. An unreadable ② context file only warns (pi).
 */
import { realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ExecutionEnv, Skill, SkillDiagnostic } from "@earendil-works/pi-agent-core";
import { loadSkills } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { loadProjectContextFiles } from "@earendil-works/pi-coding-agent";

/** A same-name skill collision (the discarded side). Surfaced, never swallowed. */
export interface SkillCollision {
  name: string;
  winnerPath: string;
  loserPath: string;
}

/** Result of loading a definition directory. Produced by {@link loadAgentDefinition}. */
export interface LoadedDefinition {
  /**
   * Project-context files feeding segment ② `<project_context>`, sourced via pi's `loadProjectContextFiles`:
   * the agentDir's own AGENTS.md/CLAUDE.md FIRST, then every AGENTS.md from root down to `cwd` (so the
   * file nearest `cwd` comes LAST — pi's array order). Empty when none exist. This WALKS cwd's ancestors (pi's coding-agent behaviour) — see core.md §6.
   */
  contextFiles: Array<{ path: string; content: string }>;
  /**
   * Verbatim `persona.md` content — the authored persona that OVERRIDES segment ①'s identity line
   * (piBasePrompt keeps the tool list + guidelines; NOT a full system-prompt replacement — that is L1
   * createPiAgent's `instructions`). undefined when absent → segment ① is the default engine identity.
   */
  persona?: string;
  skills: Skill[];
  /** Non-fatal per-file skill problems reported by pi's loader. */
  diagnostics: SkillDiagnostic[];
  /** Same-name conflicts across mounts (first-wins). */
  collisions: SkillCollision[];
  /** Absolute agent-definition directory path (persona.md/skills/ live here). */
  dir: string;
}

export interface LoadAgentDefinitionOptions {
  /**
   * Working directory whose ancestors are walked for context files (segment ②). Default = `agentDir`
   * (flat: the agent dir is also the run root). The opener passes the run root so a coding agent that
   * lives in `agentDir` picks up the host repo's AGENTS.md up the tree (core.md scenario grid).
   */
  cwd?: string;
  env?: ExecutionEnv;
}

/** Read an agent definition. persona.md/skills come from `agentDir`; ② context = pi's loadProjectContextFiles({ cwd, agentDir }). */
export async function loadAgentDefinition(
  agentDir: string,
  options: LoadAgentDefinitionOptions = {},
): Promise<LoadedDefinition> {
  // One resolved default for the working directory (env cwd AND the context-walk start), so they can
  // never diverge if a caller passes a relative agentDir.
  const cwd = options.cwd ?? agentDir;
  const e = options.env ?? new NodeExecutionEnv({ cwd });
  const rootResult = await e.absolutePath(agentDir);
  if (!rootResult.ok) {
    throw new Error(`cannot resolve agent dir "${agentDir}": ${rootResult.error.message}`);
  }
  const root = rootResult.value;

  // ② project context, following pi: the agentDir's own AGENTS.md + every AGENTS.md walking cwd up to
  // root (loadProjectContextFiles). It reads via node fs directly (mirrors pi), NOT the ExecutionEnv —
  // a deliberate, deferred deviation from this module's portable-IO policy (revisit with the sandbox; core.md §6).
  const contextFiles = loadProjectContextFiles({ cwd, agentDir: root });

  // persona.md → segment ① persona (overrides the identity line). Same error policy as AGENTS.md:
  // only not_found means "absent"; any other read error surfaces rather than silently dropping the persona.
  const personaPath = join(root, "persona.md");
  const personaRead = await e.readTextFile(personaPath);
  if (!personaRead.ok && personaRead.error.code !== "not_found") {
    throw new Error(`cannot read ${personaPath}: ${personaRead.error.message}`);
  }
  const persona = personaRead.ok ? personaRead.value : undefined;

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

  return { contextFiles, persona, skills: [...byName.values()], diagnostics, collisions, dir: root };
}

/**
 * Whether `targetPath` lives inside `baseDir` (same path counts). The self-ignore guard uses it to ask
 * "does the resolved state root land inside the workspace tree?" — an in-tree root (the default
 * `.fastagent`, or a custom `FASTAGENT_STATE_DIR` pointed inside the agent dir) is ours to self-ignore;
 * a root on an external volume resolves outside and must not be (we never write a `.gitignore` outside
 * the tree). Whether a relative override lands in-tree is a cwd question — see `resolveStateRoot`.
 */
export function isUnderDir(targetPath: string, baseDir: string): boolean {
  const rel = relative(baseDir, targetPath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Self-ignore a state dir: create it if missing, then write `<stateDir>/.gitignore` = "*" (idempotent
 * — an existing one is kept), so a workspace that runs dev/start never shows machine state as
 * untracked. Creates the dir because a caller may self-ignore it before anything else populates it
 * (e.g. `login` writing auth.json into a not-yet-created root).
 *
 * Module-PRIVATE on purpose: the only entry to the leak guard is {@link ensureStateRootSelfIgnored}
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
 * The single owner of the self-ignore MECHANISM: iff the resolved state ROOT lands inside the workspace
 * tree, write `<stateRoot>/.gitignore="*"` — which then covers EVERYTHING under it (sessions, auth.json,
 * every channel's `channels/<kind>` home). `ensureStateDirSelfIgnored` is private, so a caller cannot
 * write a `.gitignore` bypassing this.
 *
 * ROOT-based, not path-based: everything derives from the state root (config.ts), so protecting the
 * root protects all of it — INCLUDING a custom in-tree root (a `FASTAGENT_STATE_DIR` inside the agent
 * dir), the case a path-based (`.fastagent`-only) guard would leak. A per-path override
 * (`--sessions-dir`/`--auth-path`) is operator-owned: pointed at an external volume it is out-of-tree
 * (correctly not ours to ignore); pointed at a custom in-tree dir WE DON'T OWN, we do not write a
 * `.gitignore` into it (it may be a directory the operator deliberately tracks).
 *
 * Excludes the user's HOME-global `~/.fastagent` (e.g. `login`/`dev` run from `$HOME`): self-ignore is
 * for protecting state inside an agent PROJECT tree, not for writing a `.gitignore` into the user's
 * home, which a dotfiles repo may track. The global credential file there was never self-ignored.
 */
export async function ensureStateRootSelfIgnored(dir: string, stateRoot: string): Promise<void> {
  // Compare CANONICAL paths for the home check: `dir` arrives realpath-resolved (it is `process.cwd()`
  // or `resolve(".")`) but `homedir()` returns the raw `$HOME`, so a symlinked home would slip past raw
  // equality and we'd write a `.gitignore` into the real `~/.fastagent` — the very thing the doc forbids
  // (chat.ts canonicalizes for the same reason).
  if (canonicalPath(dir) === canonicalPath(homedir())) return;
  // Containment on RAW paths: stateRoot is resolve()'d (config.ts) and `dir` is absolute, so it is exact
  // by construction. An external-volume root resolves outside the tree → skip (not ours to ignore).
  if (isUnderDir(stateRoot, dir)) await ensureStateDirSelfIgnored(stateRoot);
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
