/**
 * Reads a project's raw program configuration (`fastagent.config.ts`, or compiled `fastagent.config.js` in `dist/`)
 * without pulling in harness dependencies.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AGENT_CONFIG_FILE } from "./paths.ts";

const BUILT_CONFIG_FILE = "fastagent.config.js";

export async function loadRawProgramConfig(
  dir: string,
): Promise<{ value: Record<string, unknown> | undefined; file: string }> {
  const root = resolve(dir);
  const tsPath = join(root, AGENT_CONFIG_FILE);
  const file = existsSync(tsPath)
    ? AGENT_CONFIG_FILE
    : existsSync(join(root, BUILT_CONFIG_FILE))
      ? BUILT_CONFIG_FILE
      : AGENT_CONFIG_FILE;
  const full = join(root, file);
  if (!existsSync(full)) return { value: undefined, file };
  let raw: unknown;
  try {
    raw = ((await import(pathToFileURL(full).href)) as { default?: unknown }).default;
  } catch (error) {
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (raw === undefined) return { value: undefined, file };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${file} must default-export defineAgent({ ... })`);
  }
  return { value: raw as Record<string, unknown>, file };
}
