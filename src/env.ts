import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log.ts";
import { SECRETS_DIRNAME, resolveSecretsDir } from "./paths.ts";

/**
 * Load a `.env` file into `process.env`, matching Node's `--env-file` / `process.loadEnvFile` precedence
 * on BOTH axes (verified against Node): a real env var wins over the file (an already-set key is kept),
 * and within the file a repeated key takes the LAST occurrence. Portable across Node and Bun: Bun has no
 * `process.loadEnvFile`, so we parse the file ourselves rather than depend on a Node-only entry point.
 *
 * Two phases keep the two rules distinct: parse into a map (later line overrides earlier = last-wins),
 * then apply only the keys `process.env` doesn't already have (env-wins). Minimal parser — `KEY=VALUE`
 * per line, `#` comments and blank lines skipped, surrounding matched single/double quotes stripped:
 * enough for the flat secret files fastagent reads (tokens, keys), not a full dotenv dialect (no
 * multiline, no `export`, no interpolation). A missing file throws ENOENT for the caller to treat as
 * "no .env"; any other read error propagates.
 */
export function loadEnvFile(file: string): void {
  const parsed = parseEnvContent(readFileSync(file, "utf8"));
  for (const [key, value] of parsed) {
    if (!(key in process.env)) process.env[key] = value; // env-vs-file: a real env var wins
  }
}

/** Parse .env content into key → value (the dialect above; last occurrence of a key wins). THE parser —
 *  anything else reading/deciding on .env content (e.g. `add`'s secret pre-fill) must use this, never a
 *  private re-implementation: two parsers of one dialect diverge silently. */
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

/** The agent's `.env` file: `<resolved secrets dir>/.env` — default `<agentDir>/.secrets/.env`,
 *  moved together with auth.json by `FASTAGENT_SECRETS_DIR` ({@link resolveSecretsDir} in the neutral
 *  paths.ts). THE path every reader/writer of the agent's .env must use, so "where do secrets
 *  live" cannot diverge across commands. The file's OWN location resolves from the REAL environment:
 *  commands locate + load `.env` first, so a `FASTAGENT_SECRETS_DIR` set INSIDE it still relocates
 *  auth.json but cannot move the file it is read from. */
export function dotEnvPath(agentDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveSecretsDir(agentDir, env), ".env");
}

/** The committable template: `<agentDir>/.secrets/.env.example` — deliberately NOT moved by
 *  `FASTAGENT_SECRETS_DIR`: it is authored agent surface that travels with the directory (the
 *  scaffolded `.secrets/.gitignore` un-ignores exactly it), while the real values follow the override. */
export function envExamplePath(agentDir: string): string {
  return join(agentDir, SECRETS_DIRNAME, ".env.example");
}

/**
 * Load the agent's `.env` ({@link dotEnvPath}) into `process.env` ({@link loadEnvFile}), treating a
 * MISSING file as normal (no .env) — the agent-facing entry every command + the tunnel use. `agentDir`
 * is the AGENT DIR (resolvePlacement().agentDir). Only ENOENT is swallowed; any other read error (a
 * corrupt/unreadable file) propagates, so a real problem surfaces instead of silently skipping.
 */
export function loadDotEnv(agentDir: string): void {
  const path = dotEnvPath(agentDir);
  try {
    loadEnvFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // A `.env` at the agent's root is the file habit puts there, and nothing reads it. Left silent, the
  // symptom is a setting that appears configured and is not.
  //
  // Scoped to keys FASTAGENT itself reads, because that is the only case we can be sure about: an agent
  // directory can be the author's repository too (the shape `--agent-dir .` exists for), where a root
  // `.env` is their APPLICATION's — and "move the values" would break it. Nothing here can tell those
  // apart, so the broader guess (warn whenever the agent has no env of its own) was a warning on every
  // boot, with destructive advice, aimed at the population that never had the problem. Channel
  // credentials are deliberately out of scope: a channel that cannot find its token reports that itself,
  // and it is the one that knows the name.
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
