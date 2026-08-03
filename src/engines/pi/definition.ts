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
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ExecutionEnv, Skill, SkillDiagnostic } from "@earendil-works/pi-agent-core";
import { loadSkills } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
import { assertInsideAgentDir } from "../../paths.ts";

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
   * Working directory whose ancestors are walked for context files (segment ②). Default = `agentDir`.
   * The opener passes the workspace instead, so an agent that lives in `agentDir` picks up the
   * project's AGENTS.md up the tree (core.md scenario grid).
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

  const { skills, diagnostics, collisions } = await readSkills(e, root);
  return { contextFiles, persona, skills, diagnostics, collisions, dir: root };
}

/** The skills half, shared by the full load and {@link loadAgentSkills}. `root` is already resolved. */
async function readSkills(
  e: ExecutionEnv,
  root: string,
): Promise<{ skills: Skill[]; diagnostics: SkillDiagnostic[]; collisions: SkillCollision[] }> {
  // Skills come ONLY from the definition's own skills/ (no external/global mount), so the same
  // definition loads the same skills on every machine — and, like tools/channels/schedules, a symlink
  // that escapes the agent dir is refused rather than followed (the fourth of four surfaces).
  await assertInsideAgentDir(root, "skills");
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
  return { skills: [...byName.values()], diagnostics, collisions };
}

/**
 * The definition's skills ALONE, resolved the same way `loadAgentDefinition` resolves them (same
 * loader, same containment guard, same first-wins collision rule) — for readers that need only the
 * names and must not pay the full load's ② context walk (every AGENTS.md from cwd to root) for them.
 * The control plane's `commands()` is that reader, called when a composer opens its completion list.
 */
export async function loadAgentSkills(
  agentDir: string,
  options: { cwd?: string; env?: ExecutionEnv } = {},
): Promise<{ skills: Skill[]; diagnostics: SkillDiagnostic[]; collisions: SkillCollision[]; dir: string }> {
  const cwd = options.cwd ?? agentDir;
  const e = options.env ?? new NodeExecutionEnv({ cwd });
  const rootResult = await e.absolutePath(agentDir);
  if (!rootResult.ok) throw new Error(`cannot resolve agent dir "${agentDir}": ${rootResult.error.message}`);
  // `dir` is the RESOLVED root, like {@link LoadedDefinition.dir}: readers key per-definition state
  // (the findings memo) on it, and "./agent" vs an absolute path must not become two definitions.
  return { ...(await readSkills(e, rootResult.value)), dir: rootResult.value };
}

/**
 * Whether `targetPath` lives inside `baseDir` (same path counts). Used to ask "did an override move
 * this OUT of the agent?" — the startup report's redeploy notes, `add`'s printed `.env` label, and the
 * dev watcher's "your .env is not watched" warning all turn on that fact. Reporting only: fastagent
 * does not act on where a user's paths point.
 */
export function isUnderDir(targetPath: string, baseDir: string): boolean {
  const rel = relative(baseDir, targetPath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
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
