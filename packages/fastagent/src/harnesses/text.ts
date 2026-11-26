/**
 * The definition's text, read for each request so an edit takes effect on the next answer: `SYSTEM.md` and
 * `AGENTS.md` as prompt sections, `skills/` as Agent Skills (agentskills.io) and `prompts/` as prompt templates. A
 * skill is loaded as pi does it: the prompt lists each one's name, description and location, the model reads its
 * `SKILL.md` when a task matches, and `/skill:<name>` loads it into the message.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { SendRequest } from "@fastagent-sh/client/agent-api";
import { parse as parseYaml } from "yaml";
import { log } from "../log.ts";
import type { RunsAs } from "../serving-command.ts";
/** What a Caller may offer as `/<name>`: a prompt template or a skill, expanded for the model. */
export interface AgentCommand {
  name: string;
  description?: string;
  expand(args: string): string;
}

/** One lazily evaluated prompt section contributed by an agent definition. */
export interface DefinitionSection {
  readonly key: string;
  readonly tag?: boolean;
  render(): string | undefined;
}
import { CODING_TOOL_NAMES, type CodingToolName } from "./define.ts";

interface Skill {
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

/** Whether `path` is a directory to read; a file in its place is reported, not read as empty. */
function isDirectory(path: string): boolean {
  if (!existsSync(path)) return false;
  if (statSync(path).isDirectory()) return true;
  report(`${path} is not a directory`);
  return false;
}

/** The skills in `<dir>/skills`: `<name>/SKILL.md`. One that breaks the specification or repeats a name is reported and skipped. */
export function readSkills(dir: string): Skill[] {
  const root = join(dir, "skills");
  const skills: Skill[] = [];
  if (!isDirectory(root)) return skills;
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
      report(`skill "${name}" is declared by ${taken.filePath} and ${filePath}`);
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

/** The prompt templates in `<dir>/prompts`: `<name>.md`, a `description` in the frontmatter and the body as the text. */
function readTemplates(dir: string): Template[] {
  const root = join(dir, "prompts");
  const templates: Template[] = [];
  if (!isDirectory(root)) return templates;
  for (const entry of readdirSync(root).sort()) {
    if (!entry.endsWith(".md")) continue;
    const file = join(root, entry);
    try {
      const { fields, body } = frontmatter(readFileSync(file, "utf8"), file);
      const description = typeof fields.description === "string" ? fields.description : undefined;
      templates.push({ name: entry.slice(0, -3), ...(description === undefined ? {} : { description }), body });
    } catch (error) {
      report(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return templates;
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

const SLASH_COMMAND = /^\/([^\s]+)(?:\s+([\s\S]*))?$/;

/** Expand a leading `/<command>` in user message content, returning model-facing parts and the raw command text. */
export function expandPromptCommand(
  content: SendRequest["content"],
  commands: readonly AgentCommand[],
): { content: (TextContent | ImageContent)[]; sent?: string } {
  const parts = (typeof content === "string" ? [{ type: "text" as const, text: content }] : content).map(
    (part): TextContent | ImageContent =>
      part.type === "text"
        ? { type: "text", text: part.text }
        : { type: "image", mimeType: part.mimeType, data: part.data },
  );
  const first = parts[0];
  const match = first?.type === "text" ? SLASH_COMMAND.exec(first.text) : null;
  const command = match === null ? undefined : commands.find(({ name }) => name === match[1]);
  if (first?.type !== "text" || match === null || command === undefined) return { content: parts };
  return { content: [{ type: "text", text: command.expand(match[2] ?? "") }, ...parts.slice(1)], sent: first.text };
}

/** What a Caller may offer as `/<name>`: the prompt templates, then `skill:<name>` for each skill. */
export function readCommands(dir: string): AgentCommand[] {
  return [
    ...readTemplates(dir).map(
      (template): AgentCommand => ({
        name: template.name,
        ...(template.description === undefined ? {} : { description: template.description }),
        expand: (args) => expandTemplate(template.body, parseArguments(args)),
      }),
    ),
    ...readSkills(dir).map(
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

/**
 * The prompt the definition contributes: `SYSTEM.md` as written, `AGENTS.md` as project context, the skills, where it
 * works, and, deployed, what of a change it makes to itself lasts. `runsAs` says whether it is deployed, and where.
 */
export function definitionSections(
  agentDir: string,
  options: {
    runsAs: RunsAs;
    workdir?: string;
    source?: boolean;
    codingTools?: readonly CodingToolName[];
  },
): DefinitionSection[] {
  const tools = new Set<CodingToolName>(options.codingTools ?? CODING_TOOL_NAMES);
  const hasCodingTools = tools.size > 0;
  const hasRead = tools.has("read");
  const canWrite = tools.has("write") || tools.has("edit") || tools.has("bash");
  const canExec = tools.has("bash");
  return [
    { key: "system", tag: false, render: () => fileText(join(agentDir, "SYSTEM.md")) },
    { key: "project_context", render: () => fileText(join(agentDir, "AGENTS.md")) },
    { key: "skills", render: () => (hasRead ? skillsPrompt(readSkills(agentDir)) : undefined) },
    {
      key: "workspace",
      render: () =>
        hasCodingTools
          ? workspaceSection({
              agentDir,
              workdir: options.workdir ?? agentDir,
              source: options.source === true,
              canWrite,
            })
          : undefined,
    },
    {
      key: "self_change",
      render: () => (options.runsAs.deployed ? selfChangeSection({ canWrite, canExec }) : undefined),
    },
  ];
}

/** Render the definition's current prompt sections into a single prompt string (evaluated per turn). */
export function renderDefinitionPrompt(
  agentDir: string,
  options: {
    runsAs: RunsAs;
    workdir?: string;
    source?: boolean;
    codingTools?: readonly CodingToolName[];
  },
): string | undefined {
  const texts = definitionSections(agentDir, options)
    .map((entry) => entry.render()?.trim())
    .filter((content): content is string => Boolean(content));
  return texts.length > 0 ? texts.join("\n\n") : undefined;
}

function selfChangeSection(capabilities: { canWrite: boolean; canExec: boolean }): string | undefined {
  if (!capabilities.canWrite) return undefined;
  const install = capabilities.canExec
    ? "A tool you install yourself (apt-get, npm install -g) belongs to this machine and is gone when its container is replaced. "
    : "";
  return (
    "Your directory survives restarts, including uncommitted work; /tmp does not. Your directory is this host's " +
    "storage and survives deployments of a new version. " +
    `Your definition (SYSTEM.md, AGENTS.md, skills/, prompts/, src/ and the configuration) is the author's release, ` +
    `read as it was built from where it is installed: a copy of it you make in your directory is not read. ${install}A ` +
    `capability that should outlast a deployment belongs in the author's release: propose it to them.`
  );
}

/**
 * Where the agent is: its own directory, and whether its definition there is the author's working copy or a release
 * it only reads. A result written where it does not last is how knowledge gets lost, so the agent is told which is which.
 */
function workspaceSection({
  agentDir,
  workdir,
  source,
  canWrite,
}: {
  agentDir: string;
  workdir: string;
  source: boolean;
  canWrite: boolean;
}): string {
  // A source project is the author's working copy, which `dev` exists for the agent to improve; a built package is read-only.
  const definition = source
    ? `Your definition is in ${agentDir}, the author's working copy: SYSTEM.md, AGENTS.md, skills/ and prompts/ are ` +
      `re-read for every message, so an edit to them takes effect on the next one, while src/ and the configuration ` +
      `are read when you start and need a restart.`
    : `Your definition is in ${agentDir}, which you read and do not change.`;
  if (!canWrite) {
    return workdir === agentDir
      ? `Your working directory is ${agentDir}, which holds your definition.`
      : `Your working directory is ${workdir}. ${definition}`;
  }
  return workdir === agentDir
    ? `Your working directory, ${agentDir}, is your own directory: it holds your definition, and files you create ` +
        `land there unless you put them elsewhere.`
    : `Your working directory, ${workdir}, is your own directory: files you create land there unless you put them ` +
        `elsewhere. ${definition}`;
}
