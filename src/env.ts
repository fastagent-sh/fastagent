import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log.ts";
import { installProxyFetch } from "./proxy.ts";
import { SECRETS_DIRNAME, resolveSecretsDir } from "./paths.ts";

/**
 * Load a `.env` file into `process.env`, matching Node's `--env-file` / `process.loadEnvFile` precedence on BOTH axes
 * (verified against Node).
 */
export function loadEnvFile(file: string): void {
  applyEnvValues(parseEnvContent(readFileSync(file, "utf8")));
}

/** Write parsed values into `process.env` under Node's precedence: a real env var wins over the file. */
function applyEnvValues(values: ReadonlyMap<string, string>): void {
  for (const [key, value] of values) if (!(key in process.env)) process.env[key] = value;
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

/**
 * READ a value file without entering it: the values as data, never `process.env`. A deployment's values belong to
 * the deployment being planned, so the code that decides what travels must not be able to pick up the operator's
 * shell instead. A missing file is no values, which is normal.
 */
export function loadEnvValues(file: string): Map<string, string> {
  try {
    return parseEnvContent(readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
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
 * ENTER an agent directory's runtime environment: its `.env` becomes `process.env`, and this process's outbound fetch
 * follows whatever proxy that (or the ambient environment) declares.
 *
 * ONE function because the two steps are one fact in a fixed order — the proxy can be declared in the `.env`, so it
 * has to be read first, and `installProxyFetch` reads the environment at construction. Every command used to spell
 * the pair out itself, and the ones that spelled out only half (`tool`, `add`, `attach`) shipped the bug this exists
 * to make unrepresentable: an authored tool, a channel's app-creation flow, or a skill download connecting DIRECT on a
 * machine that has no direct route. Whether a given request then uses the proxy is the dispatcher's decision, not the
 * caller's — see {@link installProxyFetch} on loopback.
 */
export function enterAgentEnv(agentDir: string): void {
  loadDotEnv(agentDir);
  installProxyFetch();
}

/**
 * Load the agent's `.env` ({@link dotEnvPath}) into `process.env` ({@link loadEnvFile}), treating a MISSING file as
 * normal (no .env). Commands want {@link enterAgentEnv}, which is this plus the proxy that `.env` may declare.
 */
export function loadDotEnv(agentDir: string): void {
  const path = dotEnvPath(agentDir);
  applyEnvValues(loadEnvValues(path)); // ONE definition of "a missing value file is normal" (loadEnvValues)
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
