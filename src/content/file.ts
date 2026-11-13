/**
 * The program's `context.json` and the content an instance's configuration adds, read in ONE place, so the opener,
 * `info`, `content list`, `tool` and deploy read one declaration; and the one shape `context.json` is written in. JSON,
 * like `mcp.json` and `package.json`, so a command, a client or the agent itself can edit it without touching
 * TypeScript.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONTEXT_FILE } from "../paths.ts";
import { type ContentEntry, type DeclaredContent, declareContent, joinContent } from "./declare.ts";

/** `context.json` as read: the content entries as written and as declared. */
export interface ContextFile {
  $schema?: string;
  content: Record<string, ContentEntry>;
  declared: DeclaredContent[];
  /** The program's MCP servers as written. Their shape is the MCP reader's to check; an edit keeps them as they are. */
  mcpServers?: Record<string, unknown>;
}

const FILE_KEYS = ["$schema", "content", "mcpServers"] as const;

/** `text`, the contents of `path`, as the object a context file is: refused when the file itself is wrong. */
function parseFile(text: string, path: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${path} must hold a JSON object`);
  const file = raw as Record<string, unknown>;
  for (const key of Object.keys(file)) {
    if (!FILE_KEYS.includes(key as never)) {
      throw new Error(`${path}: unknown key "${key}" (valid keys: ${FILE_KEYS.join(", ")})`);
    }
  }
  if (file.$schema !== undefined && typeof file.$schema !== "string") {
    throw new Error(`${path}: "$schema" must be a string`);
  }
  if (
    file.mcpServers !== undefined &&
    (typeof file.mcpServers !== "object" || file.mcpServers === null || Array.isArray(file.mcpServers))
  ) {
    throw new Error(`${path}: "mcpServers" must be an object of servers by name`);
  }
  return file;
}

/** One part of `context.json` at `path`, declared by `declare`; its refusal names the file. */
function declarePart<T>(path: string, declare: () => T): T {
  try {
    return declare();
  } catch (error) {
    throw new Error(`${path}: ${(error as Error).message}`);
  }
}

/** Read `text`, the contents of `path`, whole: what an edit, which writes the whole, reads. */
export function parseContextFile(text: string, path: string): ContextFile {
  const file = parseFile(text, path);
  const declared = declarePart(path, () => declareContent(file.content, { origin: "program", file: CONTEXT_FILE }));
  return {
    ...(file.$schema !== undefined ? { $schema: file.$schema as string } : {}),
    content: (file.content ?? {}) as Record<string, ContentEntry>,
    declared,
    ...(file.mcpServers !== undefined ? { mcpServers: file.mcpServers as Record<string, unknown> } : {}),
  };
}

/** The agent's `context.json` and its path, or undefined text when it has none (it declares nothing). */
function contextFileAt(agentDir: string): { path: string; text?: string } {
  const path = join(resolve(agentDir), CONTEXT_FILE);
  try {
    return { path, text: readFileSync(path, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path };
    throw error;
  }
}

/** The agent's `context.json`, read whole. */
export function readContextFile(agentDir: string): ContextFile {
  const { path, text } = contextFileAt(agentDir);
  return text === undefined ? { content: {}, declared: [] } : parseContextFile(text, path);
}

/** The instance configuration's content, as far as this reads it: its `content` map and where it is from. */
export interface InstanceContent {
  values: unknown;
  label: string;
  /** The configuration file's directory, which a relative `path` is relative to. */
  directory?: string;
}

/**
 * The content of the agent whose program is in `agentDir`: what its `context.json` declares, and what `instance` adds
 * to it (an instance only adds: a name both declare is refused).
 */
export function loadContent(agentDir: string, instance?: InstanceContent): DeclaredContent[] {
  const { path, text } = contextFileAt(agentDir);
  const program =
    text === undefined
      ? []
      : declarePart(path, () =>
          declareContent(parseFile(text, path).content, { origin: "program", file: CONTEXT_FILE }),
        );
  return joinContent(program, instance === undefined ? [] : instanceContent(instance));
}

/** What an instance configuration's `content` declares. */
export function instanceContent({ values, label, directory }: InstanceContent): DeclaredContent[] {
  const content = typeof values === "object" && values !== null ? (values as { content?: unknown }).content : undefined;
  return declarePart(label, () =>
    declareContent(content, {
      origin: "instance",
      file: label,
      ...(directory === undefined ? {} : { base: directory }),
    }),
  );
}

/** The program's `mcpServers` map as written in `context.json`, and the file's path, which names it in a refusal. */
export function readProgramMcpServers(agentDir: string): { values: unknown; path: string } {
  const { path, text } = contextFileAt(agentDir);
  return { values: text === undefined ? undefined : parseFile(text, path).mcpServers, path };
}

/** The text `context.json` is written as. */
export function contextFileText(file: {
  $schema?: string;
  content: Record<string, ContentEntry>;
  mcpServers?: Record<string, unknown>;
}): string {
  const out = {
    ...(file.$schema !== undefined ? { $schema: file.$schema } : {}),
    content: file.content,
    ...(file.mcpServers !== undefined && Object.keys(file.mcpServers).length > 0
      ? { mcpServers: file.mcpServers }
      : {}),
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}
