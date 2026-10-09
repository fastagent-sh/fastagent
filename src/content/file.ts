/**
 * The agent's `context.json`, read and refused whole in ONE place, so the opener, `info`, `content list`, `tool` and
 * deploy read one declaration; and the one shape it is written in. JSON, like `mcp.json` and `package.json`, so a
 * command, a client or the agent itself can edit it without touching TypeScript.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONTEXT_FILE } from "../paths.ts";
import { type ContentEntry, type DeclaredContent, declareContent } from "./declare.ts";

/** `context.json` as read: the entries as written, and as declared. */
export interface ContextFile {
  $schema?: string;
  content: Record<string, ContentEntry>;
  declared: DeclaredContent[];
}

const FILE_KEYS = ["$schema", "content"] as const;

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
  try {
    declared = declareContent(file.content);
  } catch (error) {
    throw new Error(`${path}: ${(error as Error).message}`);
  }
  return {
    ...(file.$schema !== undefined ? { $schema: file.$schema as string } : {}),
    content: (file.content ?? {}) as Record<string, ContentEntry>,
    declared,
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

/** The text `context.json` is written as. */
export function contextFileText(file: { $schema?: string; content: Record<string, ContentEntry> }): string {
  return `${JSON.stringify({ ...(file.$schema !== undefined ? { $schema: file.$schema } : {}), content: file.content }, null, 2)}\n`;
}
