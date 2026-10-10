/**
 * Definition domain: read an agent definition directory into memory — its system prompt files, its skills and prompt
 * templates (each from the agent directory's root spelling first, then pi's `.pi/` and the standard `.agents/` ones),
 * its own AGENTS.md, and what its content provides: each entry's root AGENTS.md and its skills, named `<content>/<skill>`.
 * docs/design/agent-model.md §2 is the rule this follows.
 */
import { realpathSync } from "node:fs";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  parseFrontmatter,
  type ResourceDiagnostic,
  type Skill,
  loadSkillsFromDir,
} from "@earendil-works/pi-coding-agent";
import { warnWhenChanged } from "./report.ts";
import { assertInsideAgentDir } from "../../paths.ts";
import type { ResolvedContent } from "../../content/resolve.ts";

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

/** A per-file problem pi's skill loader, or the prompt-template reader, found and skipped. */
export type DefinitionDiagnostic = ResourceDiagnostic;

/** Result of loading a definition directory. */
export interface LoadedDefinition {
  /** The agent directory's AGENTS.md, then each content entry's root one in declaration order; pi renders them as project
   *  context, each marked with its path. */
  contextFiles: DefinitionFile[];
  /** `SYSTEM.md`, else `.pi/SYSTEM.md`: replaces pi's default prompt. Absent → pi builds its default. */
  systemPrompt?: DefinitionFile;
  /** `APPEND_SYSTEM.md`, else `.pi/APPEND_SYSTEM.md`: added after the prompt, whichever it is. */
  appendSystemPrompt?: DefinitionFile;
  /** The definition's skills, then each content entry's, named `<content>/<skill>`. */
  skills: Skill[];
  prompts: DefinitionPrompt[];
  /** Non-fatal per-file problems reported by pi's skill and prompt-template loaders. */
  diagnostics: DefinitionDiagnostic[];
  /** Same-name skill conflicts across the definition's skill directories, or one content entry's (first wins). */
  collisions: SkillCollision[];
  /** Same-name files and prompt templates across the definition's locations (first wins). */
  shadowed: DefinitionShadow[];
  /** Paths that exist in the definition and are deliberately not loaded, each with why. */
  ignored: Array<{ path: string; reason: string }>;
  /** Absolute agent-definition directory path. */
  dir: string;
}

export interface LoadAgentDefinitionOptions {
  /** The agent's content, resolved: each entry's AGENTS.md and skills are read with the definition. */
  content?: readonly ResolvedContent[];
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

/** Read an agent definition: its prompt files, skills and prompt templates from `agentDir`, and what its content add. */
export async function loadAgentDefinition(
  agentDir: string,
  options: LoadAgentDefinitionOptions = {},
): Promise<LoadedDefinition> {
  const root = resolve(agentDir);

  await refuseRetiredPersona(root);

  const shadowed: DefinitionShadow[] = [];
  const ignored: LoadedDefinition["ignored"] = [];
  const systemPrompt = await readFirstFile(root, SYSTEM_PROMPT_FILES, "system prompt", shadowed, ignored);
  const appendSystemPrompt = await readFirstFile(
    root,
    APPEND_SYSTEM_PROMPT_FILES,
    "appended prompt",
    shadowed,
    ignored,
  );
  const { skills, diagnostics: skillDiagnostics, collisions } = await readSkills(root);
  const { prompts, diagnostics: promptDiagnostics } = await readPrompts(root, shadowed);
  ignored.push(...(await ignoredPaths(root)));
  // The agent works in its own directory, so its AGENTS.md is read like any working directory's: it is how this agent
  // is built and how to change it, which is the agent's own business when it improves itself.
  const own = await readIfExists(join(root, "AGENTS.md"));
  const contextFiles: DefinitionFile[] = own === undefined ? [] : [own];
  for (const entry of options.content ?? []) {
    const instructions = await readIfExists(join(entry.location, "AGENTS.md"));
    if (instructions !== undefined) contextFiles.push(instructions);
    const provided = readContentSkills(entry, ignored);
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
async function readIfExists(path: string): Promise<DefinitionFile | undefined> {
  const content = await readText(path);
  return content === undefined ? undefined : { path, content };
}

/** The file's text, or undefined when there is none; any other read failure throws. */
async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw new Error(`cannot read ${path}: ${errorMessage(error)}`);
  }
}

/** The entry's own kind, symlinks not followed; undefined when there is none; any other failure throws. */
async function entryKind(path: string): Promise<"file" | "directory" | "symlink" | "other" | undefined> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return "symlink";
    if (info.isFile()) return "file";
    return info.isDirectory() ? "directory" : "other";
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw new Error(`cannot read ${path}: ${errorMessage(error)}`);
  }
}

function isNotFound(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * pi's own skill loader, the one its sessions use, over each directory in order; each skill is marked the
 * definition's, as the session's resource loader lists it.
 */
function loadSkills(dirs: readonly string[]): { skills: Skill[]; diagnostics: DefinitionDiagnostic[] } {
  const skills: Skill[] = [];
  const diagnostics: DefinitionDiagnostic[] = [];
  for (const dir of dirs) {
    const loaded = loadSkillsFromDir({ dir, source: "fastagent" });
    for (const skill of loaded.skills) {
      skills.push({
        ...skill,
        sourceInfo: { ...skill.sourceInfo, scope: "project", origin: "top-level", baseDir: skill.baseDir },
      });
    }
    diagnostics.push(...loaded.diagnostics);
  }
  return { skills, diagnostics };
}

/** Where a content entry's skills are read from, in order: the places pi reads a project's. */
const CONTENT_SKILL_DIRS = [".pi/skills", ".agents/skills"] as const;

/**
 * A content entry's skills, named `<content>/<skill>`: about working in that entry, and never colliding with the
 * agent's own or another entry's. A skill of the project's whose own name holds a `/` is left out and said; it is not the
 * author's to rename.
 */
function readContentSkills(
  entry: ResolvedContent,
  ignored: LoadedDefinition["ignored"],
): { skills: Skill[]; diagnostics: DefinitionDiagnostic[]; collisions: SkillCollision[] } {
  const { skills: raw, diagnostics } = loadSkills(CONTENT_SKILL_DIRS.map((dir) => join(entry.location, dir)));
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
    const name = `${entry.name}/${skill.name}`;
    const existing = byName.get(name);
    if (existing) collisions.push({ name, winnerPath: existing.filePath, loserPath: skill.filePath });
    else byName.set(name, { ...skill, name });
  }
  return { skills: [...byName.values()], diagnostics, collisions };
}

async function exists(path: string): Promise<boolean> {
  return (await entryKind(path)) !== undefined;
}

async function refuseRetiredPersona(root: string): Promise<void> {
  const path = join(root, RETIRED_PERSONA);
  if (!(await exists(path))) return;
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
  root: string,
  names: readonly string[],
  what: string,
  shadowed: DefinitionShadow[],
  ignored: LoadedDefinition["ignored"],
): Promise<DefinitionFile | undefined> {
  let found: DefinitionFile | undefined;
  for (const name of names) {
    const path = join(root, name);
    const content = await readText(path);
    if (content === undefined) continue;
    if (content.trim() === "") {
      ignored.push({ path, reason: `empty, so it is not used as the ${what}` });
      continue;
    }
    if (found) shadowed.push({ what, winnerPath: found.path, loserPath: path });
    else found = { path, content };
  }
  return found;
}

/** `.pi/extensions/` is pi's place for project extensions; a definition's are `extensions/`, and only those load. */
async function ignoredPaths(root: string): Promise<LoadedDefinition["ignored"]> {
  const path = join(root, ".pi", "extensions");
  return (await exists(path)) ? [{ path, reason: "not loaded: a definition's extensions live in extensions/" }] : [];
}

/** Extension entry-point FILES under `<agentDir>/extensions/`, empty when there are none. */
export async function loadExtensionPaths(agentDir: string): Promise<string[]> {
  const root = resolve(agentDir);
  await assertInsideAgentDir(root, "extensions");
  const dir = join(root, "extensions");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw new Error(`cannot read ${dir}: ${errorMessage(error)}`);
  }
  const paths: string[] = [];
  // Said when the set changes, not on every listing: the directory is listed again for every session.
  const notices: string[] = [];
  for (const name of names) {
    const path = join(dir, name);
    const kind = await entryKind(path);
    if (kind === "symlink") {
      // EVERY symlink here is announced, without guessing whether it meant to be an extension.
      notices.push(symlinkRefused(path));
      continue;
    }
    if (name.endsWith(".ts") || name.endsWith(".js")) {
      if (kind === "file") paths.push(path);
      continue;
    }
    if (kind !== "directory") continue; // a README, a .json — not an extension, not a problem
    const index = await firstRealFile([join(path, "index.ts"), join(path, "index.js")], notices);
    if (index.path) {
      paths.push(index.path);
    } else if (!index.refused) {
      // Silent when the index WAS found and refused for being a symlink.
      notices.push(
        `[fastagent] ${path} is not a loadable extension: expected index.ts or index.js ` +
          `(pi's package.json "pi" manifest form is not supported here) — it will not be loaded`,
      );
    }
  }
  warnWhenChanged(`extensions listed in ${root}`, notices);
  return paths.sort();
}

/** The first candidate that is a REAL file, and whether one was found but REFUSED as a symlink. */
async function firstRealFile(candidates: string[], notices: string[]): Promise<{ path?: string; refused: boolean }> {
  let refused = false;
  for (const candidate of candidates) {
    const kind = await entryKind(candidate);
    if (kind === "file") return { path: candidate, refused };
    if (kind === "symlink") {
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
  root: string,
): Promise<{ skills: Skill[]; diagnostics: DefinitionDiagnostic[]; collisions: SkillCollision[] }> {
  // The definition's OWN skills — its half of the answer, from every place it may keep one, the root spelling first.
  // The machine's half is machine.ts's, and `withMachine` decides a name collision in this half's favour.
  for (const dir of SKILL_DIRS) await assertInsideAgentDir(root, dir);
  const { skills: raw, diagnostics } = loadSkills(SKILL_DIRS.map((dir) => join(root, dir)));
  const byName = new Map<string, Skill>();
  const collisions: SkillCollision[] = [];
  for (const skill of raw) {
    // pi only warns about a `/` in a skill name, and loads it. The slash names the content entry a skill comes from,
    // so a definition's own skill spelled that way could collide with an entry's and is refused here.
    if (skill.name.includes("/")) {
      throw new Error(
        `skill "${skill.name}" (${skill.filePath}): a skill's name may not contain "/", which names the content entry a ` +
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
  root: string,
  shadowed: DefinitionShadow[],
): Promise<{ prompts: DefinitionPrompt[]; diagnostics: DefinitionDiagnostic[] }> {
  const byName = new Map<string, DefinitionPrompt>();
  const diagnostics: DefinitionDiagnostic[] = [];
  for (const dir of PROMPT_DIRS) {
    await assertInsideAgentDir(root, dir);
    for (const template of await readPromptDir(join(root, dir), diagnostics)) {
      const existing = byName.get(template.name);
      if (existing) {
        shadowed.push({
          what: `prompt template "${template.name}"`,
          winnerPath: existing.filePath,
          loserPath: template.filePath,
        });
        continue;
      }
      byName.set(template.name, template);
    }
  }
  return { prompts: [...byName.values()], diagnostics };
}

/** Description of a template that declares none: its first line, as pi's own loader writes it. */
const PROMPT_DESCRIPTION_CHARS = 60;

/**
 * One directory's prompt templates, read the way pi reads a project's: its direct `.md` children (a symlink counts as
 * what it points to), named after the file. pi's own loader is not exported, and it has no place to report a
 * template it could not read, which is reported here; a missing directory has none.
 */
async function readPromptDir(dir: string, diagnostics: DefinitionDiagnostic[]): Promise<DefinitionPrompt[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (isNotFound(error)) return [];
    diagnostics.push({ type: "warning", message: errorMessage(error), path: dir });
    return [];
  }
  const prompts: DefinitionPrompt[] = [];
  for (const name of names.filter((n) => n.endsWith(".md")).sort((a, b) => a.localeCompare(b))) {
    const filePath = join(dir, name);
    let parsed: { frontmatter: Record<string, unknown>; body: string };
    try {
      if (!(await stat(filePath)).isFile()) continue;
      parsed = parseFrontmatter(await readFile(filePath, "utf8"));
    } catch (error) {
      if (isNotFound(error)) continue; // a symlink to nothing
      diagnostics.push({ type: "warning", message: errorMessage(error), path: filePath });
      continue;
    }
    const declared = parsed.frontmatter.description;
    const firstLine = parsed.body.split("\n").find((line) => line.trim());
    const description =
      typeof declared === "string" && declared
        ? declared
        : firstLine === undefined
          ? undefined
          : firstLine.length > PROMPT_DESCRIPTION_CHARS
            ? `${firstLine.slice(0, PROMPT_DESCRIPTION_CHARS)}...`
            : firstLine;
    prompts.push({
      name: name.slice(0, -".md".length),
      ...(description ? { description } : {}),
      content: parsed.body,
      filePath,
    });
  }
  return prompts;
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
