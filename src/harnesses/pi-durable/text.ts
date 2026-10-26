/**
 * The definition's text (architecture.md §3), read for each request so an edit takes effect on the next answer:
 * `SYSTEM.md` and `AGENTS.md` as prompt sections, `skills/` as Agent Skills (agentskills.io) and `prompts/` as prompt
 * templates. A skill is loaded as pi does it: the prompt lists each one's name, description and location, the model
 * reads its `SKILL.md` when a task matches, and `/skill:<name>` loads it into the message.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { type PromptSection, section } from "@earendil-works/pi-durable";
import { parse as parseYaml } from "yaml";
import type { ResolvedContent } from "../../content/resolve.ts";
import { log } from "../../log.ts";
import type { AgentCommand } from "./agent.ts";

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

/** The agent's skills: `skills/<name>/SKILL.md`. One that breaks the specification is reported and skipped. */
export function readSkills(agentDir: string): Skill[] {
  const root = join(agentDir, "skills");
  const skills: Skill[] = [];
  for (const entry of directories(root)) {
    const baseDir = join(root, entry);
    const filePath = join(baseDir, "SKILL.md");
    const label = `skills/${entry}/SKILL.md`;
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
    if (skills.some((skill) => skill.name === name)) {
      report(`${label}: another skill is named "${name}"`);
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
  return skills;
}

/** The agent's prompt templates: `prompts/<name>.md`, a `description` in the frontmatter and the body as the text. */
function readTemplates(agentDir: string): Template[] {
  const root = join(agentDir, "prompts");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .sort()
    .flatMap((entry) => {
      if (!entry.endsWith(".md")) return [];
      const label = `prompts/${entry}`;
      try {
        const { fields, body } = frontmatter(readFileSync(join(root, entry), "utf8"), label);
        const description = typeof fields.description === "string" ? fields.description : undefined;
        return [{ name: entry.slice(0, -3), ...(description === undefined ? {} : { description }), body }];
      } catch (error) {
        report(`${label}: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    });
}

/** Arguments as a shell splits them: by whitespace, with `"…"` or `'…'` keeping one argument together. */
export function parseArguments(text: string): string[] {
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
export function expandTemplate(body: string, args: readonly string[]): string {
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
export function readCommands(agentDir: string): AgentCommand[] {
  return [
    ...readTemplates(agentDir).map(
      (template): AgentCommand => ({
        name: template.name,
        ...(template.description === undefined ? {} : { description: template.description }),
        expand: (args) => expandTemplate(template.body, parseArguments(args)),
      }),
    ),
    ...readSkills(agentDir).map(
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

/** The prompt the definition contributes: `SYSTEM.md` as written, `AGENTS.md` as project context, then the skills. */
export function definitionSections(agentDir: string, content: readonly ResolvedContent[]): PromptSection[] {
  return [
    section("system", () => fileText(join(agentDir, "SYSTEM.md")), { tag: false }),
    section("project_context", () => fileText(join(agentDir, "AGENTS.md"))),
    section("skills", () => skillsPrompt(readSkills(agentDir))),
    section("content", () => contentSection({ agentDir, content })),
  ];
}

/** What a content entry of this kind is, said to the agent: where it is, and whether another instance shares it. */
function contentKind(c: ResolvedContent): string {
  if (c.kind !== "github") return "a directory on this machine";
  if (!c.clone) return `a checkout of github ${c.repo} on this machine`;
  // Brought up to date in place at each start where git can do so without touching the agent's work; what the agent
  // changes stays, and reaches anyone else only when pushed. The declared ref is what it follows, not a claim about
  // where it is: a clone the agent moved elsewhere is left there.
  const clone = `a shallow clone of github ${c.repo}${c.ref ? ` (declared ${c.ref})` : ""} in your own storage`;
  return c.readonly
    ? `${clone}, brought up to date each time you start`
    : `${clone}: what you change in it stays, and each time you start it is brought up to date where that touches nothing of yours; push to share a change`;
}

/**
 * Where the agent is and what it works on (agent-model.md §4): its own directory is itself, and each content entry is named
 * with its location, whether it is the agent's to change, and where a change there goes. A result written where it
 * does not last is how knowledge gets lost, so the agent is told which is which.
 */
function contentSection({ agentDir, content }: { agentDir: string; content: readonly ResolvedContent[] }): string {
  const own =
    `Your working directory, ${agentDir}, is your own directory: it holds your definition, and files you create ` +
    `land there unless you put them elsewhere.`;
  if (content.length === 0) return `${own} Nothing else is declared for you: you work only in your own directory.`;
  const line = (c: ResolvedContent) =>
    `- ${c.name}: ${c.location} (${contentKind(c)})${c.description !== undefined ? ` ${c.description}` : ""}`;
  const worksOn = content.filter((c) => !c.readonly);
  const knows = content.filter((c) => c.readonly);
  return [
    own,
    ...(worksOn.length > 0 ? ["You work on:", ...worksOn.map(line)] : []),
    ...(knows.length > 0 ? ["You know, and do not write:", ...knows.map(line)] : []),
    `Run a command in one of these directories with \`cd <its location> && …\`; file tools take the location directly.` +
      (worksOn.length > 0
        ? " A result worth keeping belongs in a directory you work on, not in your own directory."
        : " You write only in your own directory: the directories above are for reading."),
  ].join("\n");
}
