/**
 * The agent's value file (`.secrets/.env`, or the file `--env-file` names), read as data; entering it into
 * `process.env` is `env.ts`'s.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveSecretsDir } from "./paths.ts";

/** Parse .env content into key → value (comments/blanks skipped, surrounding quotes stripped, last occurrence wins). */
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
    parsed.set(key, value);
  }
  return parsed;
}

/**
 * Read a value file without entering it: the values as data, never `process.env`. A missing file is no values.
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
 * The value file this process's command was told to use (`--env-file`). Process state set at the command's entry, not
 * an environment variable: a variable would be read from a shell, by commands that never took the flag, and by what
 * the agent runs. A `dev` worker is spawned with its supervisor's arguments and takes the flag itself.
 */
let selectedValueFile: string | undefined;
/** Per process: a command sets it at its entry, and a command that does not (`models`) runs with the default. */
let defaultValueFile = true;

/**
 * Use `path` as the agent's value file from here on, or the default again. `defaultFile: false` is for a command that
 * talks to a deployment (`invoke --url`): it has no default file, only the one `--env-file` names, and otherwise the
 * environment it runs in.
 */
export function useValueFile(path: string | undefined, options: { defaultFile?: boolean } = {}): void {
  selectedValueFile = path;
  defaultValueFile = options.defaultFile ?? true;
}

/** The file this command reads values from, when it has one: the default's, or only `--env-file`'s. */
export function valueFileOf(agentDir: string): string | undefined {
  return defaultValueFile ? dotEnvPath(agentDir) : selectedValueFile;
}

/** The agent's `.env` file: the one `--env-file` named, else `<agentDir>/.secrets/.env`. */
export function dotEnvPath(agentDir: string): string {
  return selectedValueFile ?? join(resolveSecretsDir(agentDir), ".env");
}
