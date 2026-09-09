/** Definition domain: read an agent definition directory (AGENTS.md + skills/) into memory. */
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  BACKGROUND_CONTEXT,
  type ExecutionEnv,
  type Skill,
  type SkillDiagnostic,
  loadSkills,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
import { log } from "../../log.ts";
import { assertInsideAgentDir } from "../../paths.ts";

/** A same-name skill collision (the discarded side). */
export interface SkillCollision {
  name: string;
  winnerPath: string;
  loserPath: string;
}

/** Result of loading a definition directory. */
export interface LoadedDefinition {
  /** Project-context files feeding segment ② `<project_context>`, sourced via pi's `loadProjectContextFiles`. */
  contextFiles: Array<{ path: string; content: string }>;
  /**
   * Verbatim `persona.md` content — the authored persona that OVERRIDES segment ①'s identity line (piBasePrompt keeps
   * the tool list + guidelines; NOT a full system-prompt replacement — that is L1 createPiAgent's `instructions`).
   * undefined when absent → segment ① is the default engine identity.
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
  /** Working directory whose ancestors are walked for context files (segment ②). */
  cwd?: string;
  env?: ExecutionEnv;
}

/**
 * Read an agent definition. persona.md/skills come from `agentDir`; ② context = pi's loadProjectContextFiles({ cwd,
 * agentDir }).
 */
export async function loadAgentDefinition(
  agentDir: string,
  options: LoadAgentDefinitionOptions = {},
): Promise<LoadedDefinition> {
  // One resolved default for the working directory (env cwd AND the context-walk start), so they can never diverge if
  // a caller passes a relative agentDir.
  const cwd = options.cwd ?? agentDir;
  const e = options.env ?? new NodeExecutionEnv({ cwd });
  const rootResult = await e.absolutePath(agentDir, BACKGROUND_CONTEXT);
  if (!rootResult.ok) {
    throw new Error(`cannot resolve agent dir "${agentDir}": ${rootResult.error.message}`);
  }
  const root = rootResult.value;

  // ② project context, following pi: the agentDir's own AGENTS.md + every AGENTS.md walking cwd up to root
  // (loadProjectContextFiles).
  const contextFiles = loadProjectContextFiles({ cwd, agentDir: root });

  // persona.md → segment ① persona (overrides the identity line).
  const personaPath = join(root, "persona.md");
  const personaRead = await e.readTextFile(personaPath, BACKGROUND_CONTEXT);
  if (!personaRead.ok && personaRead.error.code !== "not_found") {
    throw new Error(`cannot read ${personaPath}: ${personaRead.error.message}`);
  }
  const persona = personaRead.ok ? personaRead.value : undefined;

  const { skills, diagnostics, collisions } = await readSkills(e, root);
  return { contextFiles, persona, skills, diagnostics, collisions, dir: root };
}

/** Extension entry-point FILES under `<agentDir>/extensions/`, empty when there are none. */
export async function loadExtensionPaths(
  agentDir: string,
  options: { cwd?: string; env?: ExecutionEnv } = {},
): Promise<string[]> {
  const cwd = options.cwd ?? agentDir;
  const e = options.env ?? new NodeExecutionEnv({ cwd });
  const rootResult = await e.absolutePath(agentDir, BACKGROUND_CONTEXT);
  if (!rootResult.ok) throw new Error(`cannot resolve agent dir "${agentDir}": ${rootResult.error.message}`);
  const root = rootResult.value;
  await assertInsideAgentDir(root, "extensions");
  const dir = join(root, "extensions");
  const listed = await e.listDir(dir, BACKGROUND_CONTEXT);
  if (!listed.ok) {
    if (listed.error.code === "not_found") return [];
    throw new Error(`cannot read ${dir}: ${listed.error.message}`);
  }
  const paths: string[] = [];
  for (const entry of listed.value) {
    if (entry.kind === "symlink") {
      // EVERY symlink here is announced, without guessing whether it meant to be an extension.
      warnSymlinkRefused(entry.path);
      continue;
    }
    if (entry.name.endsWith(".ts") || entry.name.endsWith(".js")) {
      if (entry.kind === "file") paths.push(entry.path);
      continue;
    }
    if (entry.kind === "file") continue; // a README, a .json — not an extension, not a problem
    const index = await firstRealFile(e, [join(entry.path, "index.ts"), join(entry.path, "index.js")]);
    if (index.path) {
      paths.push(index.path);
    } else if (!index.refused) {
      // Silent when the index WAS found and refused for being a symlink.
      log.warn(
        `[fastagent] ${entry.path} is not a loadable extension: expected index.ts or index.js ` +
          `(pi's package.json "pi" manifest form is not supported here) — it will not be loaded`,
      );
    }
  }
  return paths.sort();
}

/** The first candidate that is a REAL file, and whether one was found but REFUSED as a symlink. */
async function firstRealFile(e: ExecutionEnv, candidates: string[]): Promise<{ path?: string; refused: boolean }> {
  let refused = false;
  for (const candidate of candidates) {
    const info = await e.fileInfo(candidate, BACKGROUND_CONTEXT);
    if (!info.ok) {
      if (info.error.code === "not_found") continue;
      throw new Error(`cannot read ${candidate}: ${info.error.message}`);
    }
    if (info.value.kind === "file") return { path: candidate, refused };
    if (info.value.kind === "symlink") {
      warnSymlinkRefused(candidate);
      refused = true;
    }
  }
  return { refused };
}

function warnSymlinkRefused(path: string): void {
  log.warn(
    `[fastagent] ${path} is a symlink and will not be loaded: an extension must be a real file inside ` +
      `the definition so it travels with the artifact — move it in. (If it is not an extension, ` +
      `keep it outside extensions/ to silence this.)`,
  );
}

/** The skills half, shared by the full load and {@link loadAgentSkills}. */
async function readSkills(
  e: ExecutionEnv,
  root: string,
): Promise<{ skills: Skill[]; diagnostics: SkillDiagnostic[]; collisions: SkillCollision[] }> {
  // Skills come ONLY from the definition's own skills/ (no external/global mount), so the same definition loads the
  // same skills on every machine.
  await assertInsideAgentDir(root, "skills");
  const { skills: raw, diagnostics } = await loadSkills(e, [join(root, "skills")], BACKGROUND_CONTEXT);
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
 * The definition's skills ALONE, resolved the same way `loadAgentDefinition` resolves them (same loader, same
 * containment guard, same first-wins collision rule).
 */
export async function loadAgentSkills(
  agentDir: string,
  options: { cwd?: string; env?: ExecutionEnv } = {},
): Promise<{ skills: Skill[]; diagnostics: SkillDiagnostic[]; collisions: SkillCollision[]; dir: string }> {
  const cwd = options.cwd ?? agentDir;
  const e = options.env ?? new NodeExecutionEnv({ cwd });
  const rootResult = await e.absolutePath(agentDir, BACKGROUND_CONTEXT);
  if (!rootResult.ok) throw new Error(`cannot resolve agent dir "${agentDir}": ${rootResult.error.message}`);
  // `dir` is the RESOLVED root, like {@link LoadedDefinition.dir}.
  return { ...(await readSkills(e, rootResult.value)), dir: rootResult.value };
}

/** Resolve to a canonical (symlink-free) absolute path so comparisons match `process.cwd()`'s realpath. */
export function canonicalPath(p: string): string {
  const resolved = resolve(p);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}
