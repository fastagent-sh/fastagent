/**
 * The agent's `context.json`, the `context.json` of each context it uses, and this machine's `context.local.json`, read
 * in ONE place, so the opener, `info`, `content list`, `env`, `tool` and deploy read one declaration; and the one
 * shape each is written in. A reader declares the part it uses (its content, or its environment), joined across the
 * agent and its contexts (contexts/join.ts), so a part that is refused stops what uses it and is reported where it
 * is, not as the other's; an edit declares the whole of the agent's own file, since it writes the whole. JSON, like
 * `mcp.json` and `package.json`, so a command, a client or the agent itself can edit it without touching TypeScript.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONTEXT_FILE, LOCAL_CONTEXT_FILE } from "../paths.ts";
import { contextCopyText } from "../contexts/copy.ts";
import { type DeclaredEnvironment, declareEnvironment } from "../environment/declare.ts";
import {
  type ContextEntry,
  type DeclaredContext,
  canonicalContextEntry,
  contextSource,
  declareContexts,
} from "../contexts/declare.ts";
import { type DeclaredPart, joinContent, joinEnvironment } from "../contexts/join.ts";
import {
  type BoundContent,
  type ContentBinding,
  type ContentDeclaration,
  type ContentEntry,
  type DeclaredContent,
  declareBindings,
  declareCheckouts,
  declareContent,
} from "./declare.ts";

/** The agent's `context.json` as read: its contexts, its content entries as written and as declared, its environment. */
export interface ContextFile {
  $schema?: string;
  contexts: Record<string, ContextEntry>;
  declaredContexts: DeclaredContext[];
  content: Record<string, ContentEntry>;
  declared: DeclaredContent[];
  environment?: DeclaredEnvironment;
}

/** A context's own `context.json` as read: what it is for, its content and its environment. */
export interface ContextCopy {
  description?: string;
  content: DeclaredContent[];
  environment?: DeclaredEnvironment;
}

/** `context.local.json` as read: the two maps as written, and the bindings they hold. */
export interface LocalContextFile {
  /** This machine's own checkouts, by name, as written. */
  checkouts: Record<string, string>;
  /** The directories only this machine has, by name, as written. */
  content: Record<string, ContentBinding>;
  bound: BoundContent[];
}

const AGENT_FILE_KEYS = ["$schema", "contexts", "content", "environment"] as const;
const CONTEXT_COPY_KEYS = ["$schema", "description", "content", "environment"] as const;
const LOCAL_FILE_KEYS = ["checkouts", "content"] as const;

/** The key each kind of file refuses because the other holds it, with why. */
const MISPLACED: Readonly<Record<string, string>> = {
  description: `"description" says what a context is for, and this is an agent's: list the contexts it uses instead`,
  contexts: `a context uses no contexts: only an agent lists them`,
  checkouts: `"checkouts" are the checkouts of one machine: bind them in ${LOCAL_CONTEXT_FILE}`,
};

/** `text`, the contents of `path`, as the object a context file is: refused when the file itself is wrong. */
function parseFile(text: string, path: string, keys: readonly string[]): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${path} must hold a JSON object`);
  const file = raw as Record<string, unknown>;
  for (const key of Object.keys(file)) {
    if (keys.includes(key)) continue;
    const misplaced = MISPLACED[key];
    if (misplaced !== undefined) throw new Error(`${path}: ${misplaced}`);
    throw new Error(`${path}: unknown key "${key}" (valid keys: ${keys.join(", ")})`);
  }
  if (file.$schema !== undefined && typeof file.$schema !== "string") {
    throw new Error(`${path}: "$schema" must be a string`);
  }
  return file;
}

/** One part of a context file at `path`, declared by `declare`; its refusal names the file. */
function declarePart<T>(path: string, declare: () => T): T {
  try {
    return declare();
  } catch (error) {
    throw new Error(`${path}: ${(error as Error).message}`);
  }
}

/** Read `text`, the contents of `path`, whole: what an edit, which writes the whole, reads. */
export function parseContextFile(text: string, path: string): ContextFile {
  const file = parseFile(text, path, AGENT_FILE_KEYS);
  const declaredContexts = declarePart(path, () => declareContexts(file.contexts));
  const declared = declarePart(path, () => declareContent(file.content));
  const environment = declarePart(path, () => declareEnvironment(file.environment));
  return {
    ...(file.$schema !== undefined ? { $schema: file.$schema as string } : {}),
    contexts: (file.contexts ?? {}) as Record<string, ContextEntry>,
    declaredContexts,
    content: (file.content ?? {}) as Record<string, ContentEntry>,
    declared,
    ...(environment !== undefined ? { environment } : {}),
  };
}

/**
 * Read `text`, the contents of a context's `context.json` at `path`, whole. Its `description` is one line for the people
 * who choose it: it is printed in reports, never given to the model.
 */
export function parseContextCopy(text: string, path: string): ContextCopy {
  const file = parseFile(text, path, CONTEXT_COPY_KEYS);
  const description = declarePart(path, () => declareDescription(file.description));
  const content = declarePart(path, () => declareContent(file.content));
  const environment = declarePart(path, () => declareEnvironment(file.environment));
  return {
    ...(description !== undefined ? { description } : {}),
    content,
    ...(environment !== undefined ? { environment } : {}),
  };
}

function declareDescription(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  // Printed on a report line of its own: a line break would start another.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are what is refused
  if (typeof raw !== "string" || raw.trim() === "" || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new Error(`"description" must be one line of text saying what the context is for`);
  }
  return raw;
}

/** Read `text`, the contents of `path` (an agent's `context.local.json`), with paths resolved against `agentDir`. */
export function parseLocalContextFile(text: string, path: string, agentDir: string): LocalContextFile {
  const file = parseFile(text, path, LOCAL_FILE_KEYS);
  const bound = declarePart(path, () => {
    bothMapsRefused(file.checkouts, file.content);
    return [
      ...declareCheckouts(file.checkouts, resolve(agentDir)),
      ...declareBindings(file.content, resolve(agentDir)),
    ];
  });
  return {
    checkouts: (file.checkouts ?? {}) as Record<string, string>,
    content: (file.content ?? {}) as Record<string, ContentBinding>,
    bound,
  };
}

/**
 * A name in both maps would be two directories under one name, and neither file says which one is meant. The bad
 * spellings are read from the maps as written, so the refusal names them the way the file does.
 */
function bothMapsRefused(checkouts: unknown, content: unknown): void {
  if (!checkouts || typeof checkouts !== "object") return;
  for (const name of Object.keys(checkouts)) {
    const other = Object.keys(content ?? {}).find((one) => one.toLowerCase() === name.toLowerCase());
    if (other !== undefined) {
      throw new Error(`content "${other}" is bound in both "checkouts" and "content": pick one`);
    }
  }
}

/** The file at `path` and its text, or undefined text when there is none. */
function fileAt(path: string): { path: string; text?: string } {
  try {
    return { path, text: readFileSync(path, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path };
    throw error;
  }
}

/** The agent's `context.json` and its path, or undefined text when it has none (it declares nothing). */
function agentFileAt(agentDir: string): { path: string; text?: string } {
  return fileAt(join(resolve(agentDir), CONTEXT_FILE));
}

/** The agent's `context.json`, read whole. */
export function readContextFile(agentDir: string): ContextFile {
  const { path, text } = agentFileAt(agentDir);
  return text === undefined
    ? { contexts: {}, declaredContexts: [], content: {}, declared: [] }
    : parseContextFile(text, path);
}

/** This machine's `context.local.json` for the agent in `agentDir`, read whole. */
function readLocalContextFile(agentDir: string): LocalContextFile {
  const { path, text } = fileAt(join(resolve(agentDir), LOCAL_CONTEXT_FILE));
  return text === undefined ? { checkouts: {}, content: {}, bound: [] } : parseLocalContextFile(text, path, agentDir);
}

/** The contexts the agent in `agentDir` uses, as its `context.json` lists them. */
export function loadContexts(agentDir: string): DeclaredContext[] {
  const { path, text } = agentFileAt(agentDir);
  if (text === undefined) return [];
  return declarePart(path, () => declareContexts(parseFile(text, path, AGENT_FILE_KEYS).contexts));
}

function copyFile(agentDir: string, context: DeclaredContext): { path: string; file: Record<string, unknown> } {
  const path = contextSource(context.name);
  return { path, file: parseFile(contextCopyText(agentDir, context), path, CONTEXT_COPY_KEYS) };
}

/** Each context's part `declare` reads from its `context.json`, in the order the agent lists them. */
function contextParts<T>(
  agentDir: string,
  contexts: readonly DeclaredContext[],
  declare: (file: Record<string, unknown>) => T,
): DeclaredPart<T>[] {
  return contexts.map((context) => {
    const { path, file } = copyFile(agentDir, context);
    return { context: context.name, source: path, declared: declarePart(path, () => declare(file)) };
  });
}

/** The agent's own part `declare` reads, then each context's: what a reader joins. */
function partsOf<T>(agentDir: string, declare: (file: Record<string, unknown>) => T, none: T): DeclaredPart<T>[] {
  const { path, text } = agentFileAt(agentDir);
  if (text === undefined) return [{ source: CONTEXT_FILE, declared: none }];
  const file = parseFile(text, path, AGENT_FILE_KEYS);
  const contexts = declarePart(path, () => declareContexts(file.contexts));
  return [
    { source: CONTEXT_FILE, declared: declarePart(path, () => declare(file)) },
    ...contextParts(agentDir, contexts, declare),
  ];
}

/** Each context's content, for an edit that joins the agent's own content as it is about to write it. */
export function contextsContent(
  agentDir: string,
  contexts: readonly DeclaredContext[],
): DeclaredPart<DeclaredContent[]>[] {
  return contextParts(agentDir, contexts, (file) => declareContent(file.content));
}

/** Each context's environment, for an edit that joins the agent's own environment as it is about to write it. */
export function contextsEnvironment(
  agentDir: string,
  contexts: readonly DeclaredContext[],
): DeclaredPart<DeclaredEnvironment | undefined>[] {
  return contextParts(agentDir, contexts, (file) => declareEnvironment(file.environment));
}

/**
 * The content of the agent in `agentDir`: what its `context.json` and its contexts declare, joined, and what this
 * machine binds.
 */
export function loadContent(agentDir: string): ContentDeclaration {
  const declared = joinContent(partsOf(agentDir, (file) => declareContent(file.content), []));
  return { declared, bound: readLocalContextFile(agentDir).bound };
}

/** Each declarer's environment, the agent's own first: what a reader that attributes (a variable's source) reads. */
export function loadEnvironmentParts(agentDir: string): DeclaredPart<DeclaredEnvironment | undefined>[] {
  return partsOf<DeclaredEnvironment | undefined>(agentDir, (file) => declareEnvironment(file.environment), undefined);
}

/** The environment of the agent in `agentDir`, its own and its contexts' joined, or undefined when none declares one. */
export function loadEnvironment(agentDir: string): DeclaredEnvironment | undefined {
  return joinEnvironment(loadEnvironmentParts(agentDir));
}

/** The text the agent's `context.json` is written as. Contexts and an environment that declare nothing are left out. */
export function contextFileText(file: {
  $schema?: string;
  contexts?: Record<string, ContextEntry>;
  content: Record<string, ContentEntry>;
  environment?: DeclaredEnvironment;
}): string {
  const contexts = Object.fromEntries(
    Object.entries(file.contexts ?? {}).map(([name, entry]) => [name, canonicalContextEntry(entry)]),
  );
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
    ...(Object.keys(contexts).length > 0 ? { contexts } : {}),
    content: file.content,
    ...(Object.keys(environment).length > 0 ? { environment } : {}),
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** The text `context.local.json` is written as: each map left out when it holds nothing. */
export function localContextFileText(maps: {
  checkouts?: Record<string, string>;
  content?: Record<string, ContentBinding>;
}): string {
  const out = {
    ...(Object.keys(maps.checkouts ?? {}).length > 0 ? { checkouts: maps.checkouts } : {}),
    ...(Object.keys(maps.content ?? {}).length > 0 ? { content: maps.content } : {}),
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}
