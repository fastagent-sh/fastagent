/**
 * The agent's `context.json` and this machine's `context.local.json`, read in ONE place, so the opener, `info`,
 * `content list`, `env`, `tool` and deploy read one declaration; and the one shape each is written in. A reader
 * declares the part it uses (its content, or its environment), so a part that is refused stops what uses it and is
 * reported where it is, not as the other's; an edit declares the whole, since it writes the whole. JSON, like
 * `mcp.json` and `package.json`, so a command, a client or the agent itself can edit it without touching TypeScript.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONTEXT_FILE, LOCAL_CONTEXT_FILE } from "../paths.ts";
import { type DeclaredEnvironment, declareEnvironment } from "../environment/declare.ts";
import {
  type BoundContent,
  type ContentBinding,
  type ContentDeclaration,
  type ContentEntry,
  type DeclaredContent,
  declareBindings,
  declareContent,
} from "./declare.ts";

/** `context.json` as read: the content entries as written and as declared, and the environment. */
export interface ContextFile {
  $schema?: string;
  content: Record<string, ContentEntry>;
  declared: DeclaredContent[];
  environment?: DeclaredEnvironment;
}

/** `context.local.json` as read: the bindings as written and as declared. */
export interface LocalContextFile {
  content: Record<string, ContentBinding>;
  bound: BoundContent[];
}

const FILE_KEYS = ["$schema", "content", "environment"] as const;
const LOCAL_FILE_KEYS = ["content"] as const;

/** `text`, the contents of `path`, as the object a context file is: refused when the file itself is wrong. */
function parseFile(text: string, path: string, keys: readonly string[] = FILE_KEYS): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${path} must hold a JSON object`);
  const file = raw as Record<string, unknown>;
  for (const key of Object.keys(file)) {
    if (!keys.includes(key)) throw new Error(`${path}: unknown key "${key}" (valid keys: ${keys.join(", ")})`);
  }
  if (file.$schema !== undefined && typeof file.$schema !== "string") {
    throw new Error(`${path}: "$schema" must be a string`);
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
  const declared = declarePart(path, () => declareContent(file.content));
  const environment = declarePart(path, () => declareEnvironment(file.environment));
  return {
    ...(file.$schema !== undefined ? { $schema: file.$schema as string } : {}),
    content: (file.content ?? {}) as Record<string, ContentEntry>,
    declared,
    ...(environment !== undefined ? { environment } : {}),
  };
}

/** Read `text`, the contents of `path`, whole, beside the entries `context.json` declares. */
export function parseLocalContextFile(
  text: string,
  path: string,
  declared: readonly DeclaredContent[],
  agentDir: string,
): LocalContextFile {
  const file = parseFile(text, path, LOCAL_FILE_KEYS);
  const bound = declarePart(path, () => declareBindings(file.content, declared, resolve(agentDir)));
  return { content: (file.content ?? {}) as Record<string, ContentBinding>, bound };
}

/** The agent's context file `name` and its path, or undefined text when it has none (it declares nothing). */
function contextFileAt(agentDir: string, name = CONTEXT_FILE): { path: string; text?: string } {
  const path = join(resolve(agentDir), name);
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

/** This machine's `context.local.json` for the agent in `agentDir`, read whole, beside what it `declared`. */
function readLocalContextFile(agentDir: string, declared: readonly DeclaredContent[]): LocalContextFile {
  const { path, text } = contextFileAt(agentDir, LOCAL_CONTEXT_FILE);
  return text === undefined ? { content: {}, bound: [] } : parseLocalContextFile(text, path, declared, agentDir);
}

/** The content of the agent in `agentDir`: what `context.json` declares, and what this machine binds. */
export function loadContent(agentDir: string): ContentDeclaration {
  const { path, text } = contextFileAt(agentDir);
  const declared = text === undefined ? [] : declarePart(path, () => declareContent(parseFile(text, path).content));
  return { declared, bound: readLocalContextFile(agentDir, declared).bound };
}

/** The environment the agent in `agentDir` declares, or undefined when it declares none. */
export function loadEnvironment(agentDir: string): DeclaredEnvironment | undefined {
  const { path, text } = contextFileAt(agentDir);
  if (text === undefined) return undefined;
  const file = parseFile(text, path);
  return declarePart(path, () => declareEnvironment(file.environment));
}

/** The text `context.json` is written as. An environment that declares nothing is left out. */
export function contextFileText(file: {
  $schema?: string;
  content: Record<string, ContentEntry>;
  environment?: DeclaredEnvironment;
}): string {
  const packages = file.environment?.packages ?? {};
  const aptPackages = file.environment?.aptPackages ?? [];
  const variables = file.environment?.variables ?? {};
  const environment = {
    ...(Object.keys(packages).length > 0 ? { packages } : {}),
    ...(aptPackages.length > 0 ? { aptPackages } : {}),
    ...(Object.keys(variables).length > 0 ? { variables } : {}),
  };
  const out = {
    ...(file.$schema !== undefined ? { $schema: file.$schema } : {}),
    content: file.content,
    ...(Object.keys(environment).length > 0 ? { environment } : {}),
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** The text `context.local.json` is written as. */
export function localContextFileText(content: Record<string, ContentBinding>): string {
  return `${JSON.stringify({ content }, null, 2)}\n`;
}
