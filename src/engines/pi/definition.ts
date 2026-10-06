/**
 * Definition domain: read an agent definition directory into memory — its system prompt files, its skills and prompt
 * templates (each from the agent directory's root spelling first, then pi's `.pi/` and the standard `.agents/` ones),
 * its own AGENTS.md, and what its contexts provide: each one's root AGENTS.md and its skills, named `<context>/<skill>`.
 * docs/design/agent-model.md §2 is the rule this follows.
 */
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  BACKGROUND_CONTEXT,
  type ExecutionEnv,
  type PromptTemplateDiagnostic,
  type Skill,
  type SkillDiagnostic,
  loadPromptTemplates,
  loadSkills,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { warnWhenChanged } from "./report.ts";
import { assertInsideAgentDir } from "../../paths.ts";
import type { ResolvedContext } from "../../contexts/resolve.ts";

/** A same-name skill collision (the discarded side). */
export interface SkillCollision {
  name: string;
  winnerPath: string;
  loserPath: string;
}

/**
 * Two places in the definition holding the same thing: `SYSTEM.md` and `.pi/SYSTEM.md`, or one prompt template in
 * `prompts/` and `.pi/prompts/`. The first is used; the other is reported, because it is a file the author wrote that
 * does nothing.
 */
export interface DefinitionShadow {
  what: string;
  winnerPath: string;
  loserPath: string;
}

/** A file the definition holds verbatim, with where it came from. */
export interface DefinitionFile {
  path: string;
  content: string;
}

/** A prompt template of the definition's own (`prompts/`, `.pi/prompts/`). */
export interface DefinitionPrompt {
  name: string;
  description?: string;
  content: string;
  filePath: string;
}

export type DefinitionDiagnostic = SkillDiagnostic | PromptTemplateDiagnostic;

/** Result of loading a definition directory. */
export interface LoadedDefinition {
  /** The agent directory's AGENTS.md, then each context's root one in declaration order; pi renders them as project
   *  context, each marked with its path. */
  contextFiles: DefinitionFile[];
  /** `SYSTEM.md`, else `.pi/SYSTEM.md`: replaces pi's default prompt. Absent → pi builds its default. */
  systemPrompt?: DefinitionFile;
  /** `APPEND_SYSTEM.md`, else `.pi/APPEND_SYSTEM.md`: added after the prompt, whichever it is. */
  appendSystemPrompt?: DefinitionFile;
  /** The definition's skills, then each context's, named `<context>/<skill>`. */
  skills: Skill[];
  prompts: DefinitionPrompt[];
  /** Non-fatal per-file problems reported by pi's skill and prompt-template loaders. */
  diagnostics: DefinitionDiagnostic[];
  /** Same-name skill conflicts across the definition's skill directories, or one context's (first wins). */
  collisions: SkillCollision[];
  /** Same-name files and prompt templates across the definition's locations (first wins). */
  shadowed: DefinitionShadow[];
  /** Paths that exist in the definition and are deliberately not loaded, each with why. */
  ignored: Array<{ path: string; reason: string }>;
  /** Absolute agent-definition directory path. */
  dir: string;
}

export interface LoadAgentDefinitionOptions {
  env?: ExecutionEnv;
  /** The agent's contexts, resolved: their AGENTS.md and skills are read with the definition. */
  contexts?: readonly ResolvedContext[];
}

/** Where each resource is read from, in order: the root spelling first, then pi's, then the standard one. */
const SYSTEM_PROMPT_FILES = ["SYSTEM.md", ".pi/SYSTEM.md"] as const;
const APPEND_SYSTEM_PROMPT_FILES = ["APPEND_SYSTEM.md", ".pi/APPEND_SYSTEM.md"] as const;
const SKILL_DIRS = ["skills", ".pi/skills", ".agents/skills"] as const;
const PROMPT_DIRS = ["prompts", ".pi/prompts"] as const;

/**
 * The definition's locations pi also reads as a project's (its project scope is the agent directory): the machine's
 * half leaves what it finds there to the definition, which reads them with its own precedence and reports.
 */
export const PI_PROJECT_RESOURCE_DIRS = {
  skills: SKILL_DIRS.filter((dir) => dir !== "skills"),
  prompts: PROMPT_DIRS.filter((dir) => dir !== "prompts"),
};

/** The file `SYSTEM.md` and `APPEND_SYSTEM.md` replaced. Refused rather than ignored: its text would do nothing. */
const RETIRED_PERSONA = "persona.md";

/** Read an agent definition: its prompt files, skills and prompt templates from `agentDir`, and what its contexts add. */
export async function loadAgentDefinition(
  agentDir: string,
  options: LoadAgentDefinitionOptions = {},
): Promise<LoadedDefinition> {
  const e = options.env ?? new NodeExecutionEnv({ cwd: agentDir });
  const rootResult = await e.absolutePath(agentDir, BACKGROUND_CONTEXT);
  if (!rootResult.ok) {
    throw new Error(`cannot resolve agent dir "${agentDir}": ${rootResult.error.message}`);
  }
  const root = rootResult.value;

  await refuseRetiredPersona(e, root);

  const shadowed: DefinitionShadow[] = [];
  const ignored: LoadedDefinition["ignored"] = [];
  const systemPrompt = await readFirstFile(e, root, SYSTEM_PROMPT_FILES, "system prompt", shadowed, ignored);
  const appendSystemPrompt = await readFirstFile(
    e,
    root,
    APPEND_SYSTEM_PROMPT_FILES,
    "appended prompt",
    shadowed,
    ignored,
  );
  const { skills, diagnostics: skillDiagnostics, collisions } = await readSkills(e, root);
  const { prompts, diagnostics: promptDiagnostics } = await readPrompts(e, root, shadowed);
  ignored.push(...(await ignoredPaths(e, root)));
  // The agent works in its own directory, so its AGENTS.md is read like any working directory's: it is how this agent
  // is built and how to change it, which is the agent's own business when it improves itself.
  const own = await readIfExists(e, join(root, "AGENTS.md"));
  const contextFiles: DefinitionFile[] = own === undefined ? [] : [own];
  for (const context of options.contexts ?? []) {
    const instructions = await readIfExists(e, join(context.location, "AGENTS.md"));
    if (instructions !== undefined) contextFiles.push(instructions);
    const provided = await readContextSkills(e, context, ignored);
    skills.push(...provided.skills);
    skillDiagnostics.push(...provided.diagnostics);
    collisions.push(...provided.collisions);
  }
  return {
    contextFiles,
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
    skills,
    prompts,
    diagnostics: [...skillDiagnostics, ...promptDiagnostics],
    collisions,
    shadowed,
    ignored,
    dir: root,
  };
}

/** The file's content, or undefined when there is none; any other read failure throws. */
async function readIfExists(e: ExecutionEnv, path: string): Promise<DefinitionFile | undefined> {
  const read = await e.readTextFile(path, BACKGROUND_CONTEXT);
  if (read.ok) return { path, content: read.value };
  if (read.error.code === "not_found") return undefined;
  throw new Error(`cannot read ${path}: ${read.error.message}`);
}

/** Where a context's skills are read from, in order: the places pi reads a project's. */
const CONTEXT_SKILL_DIRS = [".pi/skills", ".agents/skills"] as const;

/**
 * A context's skills, named `<context>/<skill>`: about working in that context, and never colliding with the agent's
 * own or another context's. A skill of the project's whose own name holds a `/` is left out and said; it is not the
 * author's to rename.
 */
async function readContextSkills(
  e: ExecutionEnv,
  context: ResolvedContext,
  ignored: LoadedDefinition["ignored"],
): Promise<{ skills: Skill[]; diagnostics: SkillDiagnostic[]; collisions: SkillCollision[] }> {
  const { skills: raw, diagnostics } = await loadSkills(
    e,
    CONTEXT_SKILL_DIRS.map((dir) => join(context.location, dir)),
    BACKGROUND_CONTEXT,
  );
  const byName = new Map<string, Skill>();
  const collisions: SkillCollision[] = [];
  for (const skill of raw) {
    if (skill.name.includes("/")) {
      ignored.push({
        path: skill.filePath,
        reason: `not loaded: a skill's name may not contain "/" ("${skill.name}")`,
      });
      continue;
    }
    const name = `${context.name}/${skill.name}`;
    const existing = byName.get(name);
    if (existing) collisions.push({ name, winnerPath: existing.filePath, loserPath: skill.filePath });
    else byName.set(name, { ...skill, name });
  }
  return { skills: [...byName.values()], diagnostics, collisions };
}

async function exists(e: ExecutionEnv, path: string): Promise<boolean> {
  const info = await e.fileInfo(path, BACKGROUND_CONTEXT);
  if (info.ok) return true;
  if (info.error.code === "not_found") return false;
  throw new Error(`cannot read ${path}: ${info.error.message}`);
}

async function refuseRetiredPersona(e: ExecutionEnv, root: string): Promise<void> {
  const path = join(root, RETIRED_PERSONA);
  if (!(await exists(e, path))) return;
  throw new Error(
    `${path} is no longer read. Move its text to SYSTEM.md to replace pi's default prompt with an identity of the ` +
      `agent's own, or to APPEND_SYSTEM.md to add standing instructions to pi's default prompt, which already says ` +
      `who the agent is (pi's coding assistant) — an identity written there gives the model two`,
  );
}

/**
 * The first of `names` that exists, read; every later one that also exists is shadowed by it. A blank file counts as
 * absent and is reported: pi treats an empty prompt as none, so it would change nothing while looking like a prompt
 * of the agent's own.
 */
async function readFirstFile(
  e: ExecutionEnv,
  root: string,
  names: readonly string[],
  what: string,
  shadowed: DefinitionShadow[],
  ignored: LoadedDefinition["ignored"],
): Promise<DefinitionFile | undefined> {
  let found: DefinitionFile | undefined;
  for (const name of names) {
    const path = join(root, name);
    const read = await e.readTextFile(path, BACKGROUND_CONTEXT);
    if (!read.ok) {
      if (read.error.code === "not_found") continue;
      throw new Error(`cannot read ${path}: ${read.error.message}`);
    }
    if (read.value.trim() === "") {
      ignored.push({ path, reason: `empty, so it is not used as the ${what}` });
      continue;
    }
    if (found) shadowed.push({ what, winnerPath: found.path, loserPath: path });
    else found = { path, content: read.value };
  }
  return found;
}

/** `.pi/extensions/` is pi's place for project extensions; a definition's are `extensions/`, and only those load. */
async function ignoredPaths(e: ExecutionEnv, root: string): Promise<LoadedDefinition["ignored"]> {
  const path = join(root, ".pi", "extensions");
  return (await exists(e, path)) ? [{ path, reason: "not loaded: a definition's extensions live in extensions/" }] : [];
}

/** Extension entry-point FILES under `<agentDir>/extensions/`, empty when there are none. */
export async function loadExtensionPaths(agentDir: string, options: { env?: ExecutionEnv } = {}): Promise<string[]> {
  const e = options.env ?? new NodeExecutionEnv({ cwd: agentDir });
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
  // Said when the set changes, not on every listing: the directory is listed again for every session.
  const notices: string[] = [];
  for (const entry of listed.value) {
    if (entry.kind === "symlink") {
      // EVERY symlink here is announced, without guessing whether it meant to be an extension.
      notices.push(symlinkRefused(entry.path));
      continue;
    }
    if (entry.name.endsWith(".ts") || entry.name.endsWith(".js")) {
      if (entry.kind === "file") paths.push(entry.path);
      continue;
    }
    if (entry.kind === "file") continue; // a README, a .json — not an extension, not a problem
    const index = await firstRealFile(e, [join(entry.path, "index.ts"), join(entry.path, "index.js")], notices);
    if (index.path) {
      paths.push(index.path);
    } else if (!index.refused) {
      // Silent when the index WAS found and refused for being a symlink.
      notices.push(
        `[fastagent] ${entry.path} is not a loadable extension: expected index.ts or index.js ` +
          `(pi's package.json "pi" manifest form is not supported here) — it will not be loaded`,
      );
    }
  }
  warnWhenChanged(`extensions listed in ${root}`, notices);
  return paths.sort();
}

/** The first candidate that is a REAL file, and whether one was found but REFUSED as a symlink. */
async function firstRealFile(
  e: ExecutionEnv,
  candidates: string[],
  notices: string[],
): Promise<{ path?: string; refused: boolean }> {
  let refused = false;
  for (const candidate of candidates) {
    const info = await e.fileInfo(candidate, BACKGROUND_CONTEXT);
    if (!info.ok) {
      if (info.error.code === "not_found") continue;
      throw new Error(`cannot read ${candidate}: ${info.error.message}`);
    }
    if (info.value.kind === "file") return { path: candidate, refused };
    if (info.value.kind === "symlink") {
      notices.push(symlinkRefused(candidate));
      refused = true;
    }
  }
  return { refused };
}

function symlinkRefused(path: string): string {
  return (
    `[fastagent] ${path} is a symlink and will not be loaded: an extension must be a real file inside ` +
    `the definition so it travels with the artifact — move it in. (If it is not an extension, ` +
    `keep it outside extensions/ to silence this.)`
  );
}

/** The skills half of {@link loadAgentDefinition}. */
async function readSkills(
  e: ExecutionEnv,
  root: string,
): Promise<{ skills: Skill[]; diagnostics: SkillDiagnostic[]; collisions: SkillCollision[] }> {
  // The definition's OWN skills — its half of the answer, from every place it may keep one, the root spelling first.
  // The machine's half is machine.ts's, and `withMachine` decides a name collision in this half's favour.
  for (const dir of SKILL_DIRS) await assertInsideAgentDir(root, dir);
  const { skills: raw, diagnostics } = await loadSkills(
    e,
    SKILL_DIRS.map((dir) => join(root, dir)),
    BACKGROUND_CONTEXT,
  );
  const byName = new Map<string, Skill>();
  const collisions: SkillCollision[] = [];
  for (const skill of raw) {
    // pi only warns about a `/` in a skill name, and loads it. The slash names the context a skill comes from, so a
    // definition's own skill spelled that way could collide with a context's and is refused here.
    if (skill.name.includes("/")) {
      throw new Error(
        `skill "${skill.name}" (${skill.filePath}): a skill's name may not contain "/", which names the context a ` +
          `skill comes from — rename it`,
      );
    }
    const existing = byName.get(skill.name);
    if (existing) {
      collisions.push({ name: skill.name, winnerPath: existing.filePath, loserPath: skill.filePath });
    } else {
      byName.set(skill.name, skill);
    }
  }
  return { skills: [...byName.values()], diagnostics, collisions };
}

/** The prompt-template half: `prompts/`, then `.pi/prompts/`, first wins. */
async function readPrompts(
  e: ExecutionEnv,
  root: string,
  shadowed: DefinitionShadow[],
): Promise<{ prompts: DefinitionPrompt[]; diagnostics: PromptTemplateDiagnostic[] }> {
  const byName = new Map<string, DefinitionPrompt>();
  const diagnostics: PromptTemplateDiagnostic[] = [];
  for (const dir of PROMPT_DIRS) {
    await assertInsideAgentDir(root, dir);
    const loaded = await loadPromptTemplates(e, join(root, dir), BACKGROUND_CONTEXT);
    diagnostics.push(...loaded.diagnostics);
    for (const template of loaded.promptTemplates) {
      // pi's loader names a template after its file and reads direct children only, so this is its file.
      const filePath = join(root, dir, `${template.name}.md`);
      const existing = byName.get(template.name);
      if (existing) {
        shadowed.push({
          what: `prompt template "${template.name}"`,
          winnerPath: existing.filePath,
          loserPath: filePath,
        });
        continue;
      }
      byName.set(template.name, {
        name: template.name,
        ...(template.description ? { description: template.description } : {}),
        content: template.content,
        filePath,
      });
    }
  }
  return { prompts: [...byName.values()], diagnostics };
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
