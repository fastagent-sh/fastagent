/**
 * The definition's text and the instance's, read for each request so an
 * edit takes effect on the next answer: `SYSTEM.md` and `AGENTS.md` as prompt sections, `skills/` as Agent Skills
 * (agentskills.io) and `prompts/` as prompt templates, each with the files and directories the instance adds
 * (text-sources.ts). A skill is loaded as pi does it: the prompt lists each one's name, description and location, the model
 * reads its `SKILL.md` when a task matches, and `/skill:<name>` loads it into the message.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { type PromptSection, section } from "@earendil-works/pi-durable";
import { parse as parseYaml } from "yaml";
import type { ResolvedContent } from "../../content/resolve.ts";
import { log } from "../../log.ts";
import type { RunsAs } from "../../serving-command.ts";
import type { AgentCommand } from "./agent.ts";
import type { InstanceConfigSource } from "./config.ts";
import { NOUN, type TextSource, type TextSources, declareText, programText, whatIs } from "./text-sources.ts";

export interface Skill {
  name: string;
  description: string;
  /** Absolute: what the model's `read` opens. */
  filePath: string;
  baseDir: string;
  /** Offered only through `/skill:<name>`, never listed to the model. */
  disableModelInvocation: boolean;
}

interface Template {
  name: string;
  description?: string;
  body: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** A file's YAML frontmatter and its body. A file without frontmatter is all body. */
function frontmatter(text: string, file: string): { fields: Record<string, unknown>; body: string } {
  const match = FRONTMATTER.exec(text);
  if (match === null) return { fields: {}, body: text };
  const fields = parseYaml(match[1] as string) as unknown;
  if (fields !== null && (typeof fields !== "object" || Array.isArray(fields))) {
    throw new Error(`${file}: its frontmatter is not a set of fields`);
  }
  return { fields: (fields ?? {}) as Record<string, unknown>, body: text.slice(match[0].length) };
}

/** Each problem once per process: the text is read for every request, and a broken file should not flood the log. */
const reported = new Set<string>();
function report(problem: string): void {
  if (reported.has(problem)) return;
  reported.add(problem);
  log.warn(`[fastagent] ${problem}; it is skipped`);
}

/** The directories in `dir`. An entry that cannot be read (a symlink to nothing) is reported and skipped. */
function directories(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .filter((name) => {
      if (name.startsWith(".")) return false;
      try {
        return statSync(join(dir, name)).isDirectory();
      } catch (error) {
        report(`${join(basename(dir), name)}: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    });
}

/**
 * Whether a source is there to read as `kind`: one an instance declared that has gone, or become what its kind is not,
 * is reported, not read as empty.
 */
function present({ path, declaredBy }: TextSource, kind: keyof typeof NOUN): boolean {
  const found = whatIs(path);
  if (found === NOUN[kind] || (found !== undefined && declaredBy === undefined)) return true;
  if (declaredBy !== undefined) {
    report(`${path}: ${declaredBy} declares it, and ${found === undefined ? "it is gone" : `it is a ${found} now`}`);
  }
  return false;
}

/** What a name taken twice is told as: where, so the entry that is skipped can be found. */
type Collide = (problem: string, byInstance: boolean) => void;

const collisionOf = (kind: string, name: string, taken: string, file: string, byInstance: boolean): string =>
  `${kind} "${name}" is declared by ${taken} and ${file}` +
  (byInstance ? `: an instance adds to the program's ${kind}s and does not replace them — name it otherwise` : "");

/** The skills in `sources`: `<dir>/<name>/SKILL.md`. One that breaks the specification is reported and skipped. */
function loadSkills(sources: readonly TextSource[], collide: Collide): Skill[] {
  const skills: Skill[] = [];
  for (const source of sources) {
    if (present(source, "skills")) readSkillsOf(source, skills, collide);
  }
  return skills;
}

/** The skills of one directory, added to `skills`. */
function readSkillsOf(source: TextSource, skills: Skill[], collide: Collide): void {
  const root = source.path;
  for (const entry of directories(root)) {
    const baseDir = join(root, entry);
    const filePath = join(baseDir, "SKILL.md");
    const label = filePath;
    if (!existsSync(filePath)) continue;
    let fields: Record<string, unknown>;
    try {
      ({ fields } = frontmatter(readFileSync(filePath, "utf8"), label));
    } catch (error) {
      report(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const name = fields.name ?? entry;
    const { description } = fields;
    if (typeof name !== "string" || name.length > 64 || !SKILL_NAME.test(name)) {
      report(`${label}: "name" must be lowercase letters, digits and single hyphens, at most 64 characters`);
      continue;
    }
    if (typeof description !== "string" || description.trim() === "" || description.length > 1024) {
      report(`${label}: "description" must be a text of at most 1024 characters`);
      continue;
    }
    const taken = skills.find((skill) => skill.name === name);
    if (taken !== undefined) {
      const byInstance = source.declaredBy !== undefined;
      collide(collisionOf("skill", name, taken.filePath, filePath, byInstance), byInstance);
      continue;
    }
    skills.push({
      name,
      description: description.trim(),
      filePath,
      baseDir,
      disableModelInvocation: fields["disable-model-invocation"] === true,
    });
  }
}

/** The skills the agent offers, reported and skipped as above. */
export const readSkills = (sources: readonly TextSource[]): Skill[] => loadSkills(sources, report);

/** The prompt templates in `sources`: `<dir>/<name>.md`, a `description` in the frontmatter and the body as the text. */
function loadTemplates(sources: readonly TextSource[], collide: Collide): Template[] {
  const templates: Template[] = [];
  const files = new Map<string, string>();
  for (const source of sources) {
    if (!present(source, "prompts")) continue;
    for (const entry of readdirSync(source.path).sort()) {
      if (!entry.endsWith(".md")) continue;
      const file = join(source.path, entry);
      const name = entry.slice(0, -3);
      const taken = files.get(name);
      if (taken !== undefined) {
        const byInstance = source.declaredBy !== undefined;
        collide(collisionOf("prompt template", name, taken, file, byInstance), byInstance);
        continue;
      }
      try {
        const { fields, body } = frontmatter(readFileSync(file, "utf8"), file);
        const description = typeof fields.description === "string" ? fields.description : undefined;
        templates.push({ name, ...(description === undefined ? {} : { description }), body });
        files.set(name, file);
      } catch (error) {
        report(`${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return templates;
}

/**
 * The instance's text as it will be read: declared, and refused when an instance entry takes a name the program (or an
 * earlier instance entry) has. Called at open; what goes wrong afterwards is reported as each message reads it.
 */
export function openText(dir: string, instance: InstanceConfigSource | undefined): TextSources {
  const text = declareText(dir, instance);
  const refuse: Collide = (problem, byInstance) => {
    if (byInstance) throw new Error(`${instance?.label}: ${problem}`);
  };
  loadSkills(text.skills, refuse);
  loadTemplates(text.prompts, refuse);
  return text;
}

/** Arguments as a shell splits them: by whitespace, with `"…"` or `'…'` keeping one argument together. */
function parseArguments(text: string): string[] {
  const args: string[] = [];
  let current = "";
  let started = false;
  let quote: string | undefined;
  for (const char of text) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) args.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) args.push(current);
  return args;
}

/**
 * A template's text with its arguments, in pi's format: `$1`… positional, `$@` and `$ARGUMENTS` all of them,
 * `${N:-default}` a positional one or its default, `${@:N}` and `${@:N:L}` a slice from the Nth.
 */
function expandTemplate(body: string, args: readonly string[]): string {
  const all = args.join(" ");
  return body.replace(
    /\$\{(\d+|@|ARGUMENTS):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
    (_match, target?: string, fallback?: string, from?: string, length?: string, simple?: string) => {
      if (target !== undefined) {
        const value = target === "@" || target === "ARGUMENTS" ? all : args[Number(target) - 1];
        return value ? value : (fallback ?? "");
      }
      if (from !== undefined) {
        const start = Math.max(0, Number(from) - 1);
        return (length === undefined ? args.slice(start) : args.slice(start, start + Number(length))).join(" ");
      }
      return simple === "@" || simple === "ARGUMENTS" ? all : (args[Number(simple) - 1] ?? "");
    },
  );
}

/** A skill's instructions as a message carries them when `/skill:<name>` loads it, as pi does. */
function loadedSkill(skill: Skill, args: string): string {
  const { body } = frontmatter(readFileSync(skill.filePath, "utf8"), skill.filePath);
  const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body.trim()}\n</skill>`;
  return args.trim() === "" ? block : `${block}\n\n${args.trim()}`;
}

/** What a Caller may offer as `/<name>`: the prompt templates, then `skill:<name>` for each skill. */
export function readCommands(text: TextSources): AgentCommand[] {
  return [
    ...loadTemplates(text.prompts, report).map(
      (template): AgentCommand => ({
        name: template.name,
        ...(template.description === undefined ? {} : { description: template.description }),
        expand: (args) => expandTemplate(template.body, parseArguments(args)),
      }),
    ),
    ...readSkills(text.skills).map(
      (skill): AgentCommand => ({
        name: `skill:${skill.name}`,
        description: skill.description,
        expand: (args) => loadedSkill(skill, args),
      }),
    ),
  ];
}

const escapeXml = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

/** The skills the model may choose, as pi lists them: a skill's instructions are loaded only when a task needs them. */
function skillsPrompt(skills: readonly Skill[]): string | undefined {
  const listed = skills.filter((skill) => !skill.disableModelInvocation);
  if (listed.length === 0) return undefined;
  return [
    "The following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
    ...listed.flatMap((skill) => [
      "  <skill>",
      `    <name>${escapeXml(skill.name)}</name>`,
      `    <description>${escapeXml(skill.description)}</description>`,
      `    <location>${escapeXml(skill.filePath)}</location>`,
      "  </skill>",
    ]),
    "</available_skills>",
  ].join("\n");
}

const fileText = (path: string): string | undefined => {
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, "utf8").trim();
  return text === "" ? undefined : text;
};

/** The instance's files of instructions, in the order it declared them. */
function instructionsText(sources: readonly TextSource[]): string | undefined {
  const texts = sources.filter((source) => present(source, "instructions")).flatMap(({ path }) => fileText(path) ?? []);
  return texts.length === 0 ? undefined : texts.join("\n\n");
}

/**
 * The prompt the definition contributes: `SYSTEM.md` as written, `AGENTS.md` as project context, the skills, where it
 * works, and, deployed, what of a change it makes to itself lasts. `wake`: the agent has the wake tool; `runsAs` says
 * whether it is deployed, and where.
 */
export function definitionSections(
  agentDir: string,
  content: readonly ResolvedContent[],
  options: { wake: boolean; runsAs: RunsAs; workdir?: string; text?: TextSources; source?: boolean },
): PromptSection[] {
  const text = options.text ?? programText(agentDir);
  return [
    section("system", () => fileText(join(agentDir, "SYSTEM.md")), { tag: false }),
    section("project_context", () => fileText(join(agentDir, "AGENTS.md"))),
    section("instance_context", () => instructionsText(text.instructions)),
    section("skills", () => skillsPrompt(readSkills(text.skills))),
    section("content", () =>
      contentSection({ agentDir, workdir: options.workdir ?? agentDir, source: options.source === true, content }),
    ),
    section("self_change", () =>
      options.runsAs.deployed ? selfChangeSection(options.wake, options.runsAs.ephemeralRoot === true) : undefined,
    ),
  ];
}

function selfChangeSection(wake: boolean, ephemeralRoot: boolean): string {
  const storage = ephemeralRoot
    ? "Every deployment of a new version resets this host's storage entirely, your directory with it, so anything " +
      "that must outlive a deployment belongs in an external system (a git remote, an issue tracker, a database)."
    : "Your directory is this host's storage and survives deployments of a new version.";
  return (
    `Your directory survives restarts, including uncommitted work; /tmp does not. ${storage} ` +
    `Your definition (SYSTEM.md, AGENTS.md, skills/, prompts/, src/ and the configuration) is the author's release, ` +
    `read as it was built from where it is installed: a copy of it you make in your directory is not read. A tool you install ` +
    `yourself (apt-get, npm install -g) belongs to this machine and is gone when its container is replaced. A ` +
    `capability that should outlast a deployment belongs in the author's release: propose it to them.` +
    // Named only when it has the tool: naming a tool the model does not have invites calls to it.
    (wake ? " To schedule your own follow-up work, use the wake tool." : "")
  );
}

/** What a content entry of this kind is, said to the agent: where it is, and whether another instance shares it. */
function contentKind(c: ResolvedContent): string {
  if (c.kind !== "github") return "a directory on this machine";
  // Brought up to date in place at each start where git can do so without touching the agent's work; what the agent
  // changes stays, and reaches anyone else only when pushed. The declared ref is what it follows, not a claim about
  // where it is: a clone the agent moved elsewhere is left there.
  const clone = `a shallow clone of github ${c.repo}${c.ref ? ` (declared ${c.ref})` : ""} in your own storage`;
  return `${clone}: what you change in it stays, and each time you start it is brought up to date where that touches nothing of yours; push to share a change`;
}

/**
 * Where the agent is and what it works on: its own directory is itself, and each content entry is named
 * with its location and where a change there goes. A result written where it does not last is how knowledge gets
 * lost, so the agent is told which is which.
 */
function contentSection({
  agentDir,
  workdir,
  source,
  content,
}: {
  agentDir: string;
  workdir: string;
  source: boolean;
  content: readonly ResolvedContent[];
}): string {
  // A source project is the author's working copy, which `dev` exists for the agent to improve; a built package is read-only.
  const definition = source
    ? `Your definition is in ${agentDir}, the author's working copy: SYSTEM.md, AGENTS.md, skills/ and prompts/ are ` +
      `re-read for every message, so an edit to them takes effect on the next one, while src/ and the configuration ` +
      `are read when you start and need a restart.`
    : `Your definition is in ${agentDir}, which you read and do not change.`;
  const own =
    workdir === agentDir
      ? `Your working directory, ${agentDir}, is your own directory: it holds your definition, and files you create ` +
        `land there unless you put them elsewhere.`
      : `Your working directory, ${workdir}, is your own directory: files you create land there unless you put them ` +
        `elsewhere. ${definition}`;
  if (content.length === 0) return `${own} Nothing else is declared for you: you work only in your own directory.`;
  const line = (c: ResolvedContent) =>
    `- ${c.name}: ${c.location} (${contentKind(c)})${c.description !== undefined ? ` ${c.description}` : ""}`;
  return [
    own,
    "You work on:",
    ...content.map(line),
    `Run a command in one of these directories with \`cd <its location> && …\`; file tools take the location directly. ` +
      `A result worth keeping belongs in a directory you work on, not in your own directory.`,
  ].join("\n");
}
