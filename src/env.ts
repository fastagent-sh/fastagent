import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log.ts";
import { installProxyFetch } from "./proxy.ts";
import { SECRETS_DIRNAME, resolveSecretsDir } from "./paths.ts";

/**
 * Write parsed values into `process.env`, matching Node's `--env-file` / `process.loadEnvFile` precedence on BOTH
 * axes (verified against Node in test/env.test.ts): a real env var wins over the file, and within the file the last
 * occurrence wins ({@link parseEnvContent}).
 */
export function applyEnvValues(values: ReadonlyMap<string, string>): void {
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
 * READ a value file without entering it: the values as data, never `process.env`. This is how code reasons about an
 * environment OTHER than its own — `deploy` resolves configuration in the environment being deployed, which this
 * file declares, and merging it into the running process would put the two environments in one bag. A missing file
 * is no values, which is normal.
 */
export function loadEnvValues(file: string): Map<string, string> {
  try {
    return parseEnvContent(readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
}

/**
 * Say so when the plaintext value file is readable by other accounts on the box. Reported HERE because this is the
 * one function every command goes through to read it, and because reporting is all fastagent does about a file's
 * mode after the fact: `add <channel>` tightens what it is about to write into, but `dev`/`start`/`login`/`deploy`
 * only read, and silently changing the mode of a file an operator has been running with is not theirs to do.
 *
 * The case that makes this worth a line: an agent scaffolded by an older version got a `.env` at the umask, and
 * nothing since re-writes it, so without this the file stays world-readable with no indication anywhere.
 */
function warnIfWorldReadable(path: string): void {
  const mode = statSync(path, { throwIfNoEntry: false })?.mode;
  if (mode === undefined || (mode & 0o077) === 0) return;
  log.warn(
    `[fastagent] ${path} holds plaintext values and is readable by other accounts (mode ` +
      `${(mode & 0o777).toString(8)}) — \`chmod 600 ${path}\``,
  );
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
 * Load the agent's `.env` ({@link dotEnvPath}) into `process.env` ({@link applyEnvValues}), treating a MISSING file as
 * normal (no .env). Commands want {@link enterAgentEnv}, which is this plus the proxy that `.env` may declare.
 */
export function loadDotEnv(agentDir: string): void {
  const path = dotEnvPath(agentDir);
  applyEnvValues(loadEnvValues(path)); // ONE definition of "a missing value file is normal" (loadEnvValues)
  warnIfWorldReadable(path);
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
