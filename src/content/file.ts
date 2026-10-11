/**
 * The agent's `context.json`, read and refused whole in ONE place, so the opener, `info`, `content list`, `env`, `tool`
 * and deploy read one declaration (its content, and its environment); and the one shape it is written in. JSON, like
 * `mcp.json` and `package.json`, so a command, a client or the agent itself can edit it without touching TypeScript.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONTEXT_FILE } from "../paths.ts";
import { type DeclaredEnvironment, declareEnvironment } from "../environment/declare.ts";
import { type ContentEntry, type DeclaredContent, declareContent } from "./declare.ts";

/** `context.json` as read: the content entries as written and as declared, and the environment. */
export interface ContextFile {
  $schema?: string;
  content: Record<string, ContentEntry>;
  declared: DeclaredContent[];
  environment?: DeclaredEnvironment;
}

const FILE_KEYS = ["$schema", "content", "environment"] as const;

/** Read `text`, the contents of `path`. Every refusal names the file. */
export function parseContextFile(text: string, path: string): ContextFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${path} must hold a JSON object`);
  const file = raw as Record<string, unknown>;
  for (const key of Object.keys(file)) {
    if (!(FILE_KEYS as readonly string[]).includes(key)) {
      throw new Error(`${path}: unknown key "${key}" (valid keys: ${FILE_KEYS.join(", ")})`);
    }
  }
  if (file.$schema !== undefined && typeof file.$schema !== "string") {
    throw new Error(`${path}: "$schema" must be a string`);
  }
  let declared: DeclaredContent[];
  let environment: DeclaredEnvironment | undefined;
  try {
    declared = declareContent(file.content);
    environment = declareEnvironment(file.environment);
  } catch (error) {
    throw new Error(`${path}: ${(error as Error).message}`);
  }
  return {
    ...(file.$schema !== undefined ? { $schema: file.$schema as string } : {}),
    content: (file.content ?? {}) as Record<string, ContentEntry>,
    declared,
    ...(environment !== undefined ? { environment } : {}),
  };
}

/** The agent's `context.json`, read; an agent without one declares no content. */
export function readContextFile(agentDir: string): ContextFile {
  const path = join(resolve(agentDir), CONTEXT_FILE);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { content: {}, declared: [] };
    throw error;
  }
  return parseContextFile(text, path);
}

/** The content the agent in `agentDir` declares. */
export function loadContent(agentDir: string): DeclaredContent[] {
  return readContextFile(agentDir).declared;
}

/** The environment the agent in `agentDir` declares, or undefined when it declares none. */
export function loadEnvironment(agentDir: string): DeclaredEnvironment | undefined {
  return readContextFile(agentDir).environment;
}

/** The text `context.json` is written as. An environment that declares nothing is left out. */
export function contextFileText(file: {
  $schema?: string;
  content: Record<string, ContentEntry>;
  environment?: DeclaredEnvironment;
}): string {
  const packages = file.environment?.packages ?? {};
  const aptPackages = file.environment?.aptPackages ?? [];
  const environment = {
    ...(Object.keys(packages).length > 0 ? { packages } : {}),
    ...(aptPackages.length > 0 ? { aptPackages } : {}),
  };
  const out = {
    ...(file.$schema !== undefined ? { $schema: file.$schema } : {}),
    content: file.content,
    ...(Object.keys(environment).length > 0 ? { environment } : {}),
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}
