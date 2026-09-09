import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log.ts";
import { SECRETS_DIRNAME, resolveSecretsDir } from "./paths.ts";

/**
 * Load a `.env` file into `process.env`, matching Node's `--env-file` / `process.loadEnvFile` precedence on BOTH axes
 * (verified against Node).
 */
export function loadEnvFile(file: string): void {
  const parsed = parseEnvContent(readFileSync(file, "utf8"));
  for (const [key, value] of parsed) {
    if (!(key in process.env)) process.env[key] = value; // env-vs-file: a real env var wins
  }
}

/** Parse .env content into key → value (the dialect above; last occurrence of a key wins). */
export function parseEnvContent(content: string): Map<string, string> {
  const parsed = new Map<string, string>();
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue; // no `=`, or an empty key
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.at(-1) === quote) value = value.slice(1, -1);
    parsed.set(key, value); // in-file: last occurrence wins (Map overwrite)
  }
  return parsed;
}

/** The agent's `.env` file: `<resolved secrets dir>/.env`. */
export function dotEnvPath(agentDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveSecretsDir(agentDir, env), ".env");
}

/** The committable template: `<agentDir>/.secrets/.env.example`. */
export function envExamplePath(agentDir: string): string {
  return join(agentDir, SECRETS_DIRNAME, ".env.example");
}

/**
 * Load the agent's `.env` ({@link dotEnvPath}) into `process.env` ({@link loadEnvFile}), treating a MISSING file as
 * normal (no .env).
 */
export function loadDotEnv(agentDir: string): void {
  const path = dotEnvPath(agentDir);
  try {
    loadEnvFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // A `.env` at the agent's root is the file habit puts there, and nothing reads it.
  const stray = join(agentDir, ".env");
  if (stray === path || !existsSync(stray)) return;
  const misplaced = [...parseEnvContent(readFileSync(stray, "utf8")).keys()].filter((k) => k.startsWith("FASTAGENT_"));
  if (misplaced.length > 0) {
    log.warn(
      `[fastagent] ${stray} is NOT read — it sets ${misplaced.join(", ")}, and this agent's env lives at ` +
        `${path}; move those values there`,
    );
  }
}
