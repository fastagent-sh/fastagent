import { readFileSync } from "node:fs";
import { join } from "node:path";

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
  const content = readFileSync(file, "utf8");
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
  for (const [key, value] of parsed) {
    if (!(key in process.env)) process.env[key] = value; // env-vs-file: a real env var wins
  }
}

/**
 * Load `<dir>/.env` into `process.env` ({@link loadEnvFile}), treating a MISSING file as normal (no .env)
 * — the workspace-facing entry every command + the tunnel use. Only ENOENT is swallowed; any other read
 * error (a corrupt/unreadable file) propagates, so a real problem surfaces instead of silently skipping.
 */
export function loadDotEnv(dir: string): void {
  try {
    loadEnvFile(join(dir, ".env"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
