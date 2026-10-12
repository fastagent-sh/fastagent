/**
 * A fetched context's authoritative snapshot: identity and declaration in one atomically replaced file. Readers
 * open it once, so refreshing never exposes a missing directory or mismatched identity/declaration. context.json is
 * a human-readable mirror; Railway strips .git, so neither identity nor declaration depends on git metadata.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { contextCopyPath } from "../paths.ts";
import { type DeclaredContext, contextSource } from "./declare.ts";

export const COPY_RECORD = ".fastagent-context.json";

export function contextCopyFiles(name: string): string[] {
  const declaration = contextSource(name);
  return [declaration, `${dirname(declaration)}/${COPY_RECORD}`];
}

export interface CopyRecord {
  repo: string;
  ref?: string;
  commit: string;
  declaration: string;
}

export function readCopyRecord(agentDir: string, name: string, repo?: string): CopyRecord {
  const path = join(contextCopyPath(agentDir, name), COPY_RECORD);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new Error(
      `context "${name}"${repo ? ` (github ${repo})` : ""} is not fetched here: run \`fastagent context fetch\` in ` +
        resolve(agentDir),
    );
  }
  let record: CopyRecord;
  try {
    record = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  if (
    !record ||
    typeof record !== "object" ||
    typeof record.repo !== "string" ||
    (record.ref !== undefined && typeof record.ref !== "string") ||
    typeof record.commit !== "string" ||
    !/^[0-9a-f]{40}$/i.test(record.commit) ||
    typeof record.declaration !== "string"
  ) {
    throw new Error(`${path} is not a fetched context record: run \`fastagent context fetch\``);
  }
  return record;
}

export function copyRecord(agentDir: string, context: DeclaredContext): CopyRecord {
  const record = readCopyRecord(agentDir, context.name, context.repo);
  if (record.repo !== context.repo || record.ref !== context.ref) {
    throw new Error(
      `context "${context.name}" was fetched from another repository or ref: run \`fastagent context fetch\``,
    );
  }
  return record;
}

export function contextCopyText(agentDir: string, context: DeclaredContext): string {
  return copyRecord(agentDir, context).declaration;
}
