/**
 * The selected environment's value file (`.secrets/.env`, or `.secrets/production/.env` for a deployment), read and
 * written; entering it into `process.env` is env.ts's. Read as data: what it declares, and what it adds to an agent's
 * environment. Written: what a command generates (a channel's secret, the Agent API's key) goes in as an active
 * `NAME=value` line, a value already set stays, and the secrets directory fastagent made carries its own `.gitignore`.
 */
import { readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SECRETS_DIRNAME, SECRET_FILE_MODE, exists, resolveSecretsDir } from "./paths.ts";
import { baseTemplate } from "./scaffold/templates.ts";

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

/** The agent's `.env` file: `<resolved secrets dir>/.env`. */
export function dotEnvPath(agentDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveSecretsDir(agentDir, env), ".env");
}

/** The committable template: `<agentDir>/.secrets/.env.example`. */
export function envExamplePath(agentDir: string): string {
  return join(agentDir, SECRETS_DIRNAME, ".env.example");
}

/**
 * What the agent's value file ({@link dotEnvPath}) adds to this process's environment, read and not entered: each
 * variable the process does not hold, as entering the file would set it. An agent opened in a process that runs
 * others too reads its own values through this; one that a command entered (`dev`, `start`) adds nothing here.
 */
export function agentValues(agentDir: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of loadEnvValues(dotEnvPath(agentDir))) if (!(key in process.env)) values[key] = value;
  return values;
}

/** One variable to write: with a `value`, an active line; without one, a placeholder under its `hint`. */
export interface ValueEntry {
  name: string;
  value?: string;
  hint?: string;
}

export interface ValueWriteResult {
  /** Generated values written as active `NAME=value` lines. */
  written: string[];
  /** Vars already present with a non-empty active value; left untouched and omitted from next steps. */
  alreadySet: string[];
  /** Set when the secrets dir is an operator-chosen one (`FASTAGENT_SECRETS_DIR`) carrying no `.gitignore`. */
  unprotectedSecretsDir?: string;
}

/** What a command says when it wrote a secret into a secrets directory fastagent does not own and git may track. */
export function unprotectedSecretsNote(dir: string): string {
  return (
    `${dir} (FASTAGENT_SECRETS_DIR) now holds a secret and has no .gitignore — that directory is yours, so ` +
    "fastagent will not write one into it. Make sure git does not track what is in there."
  );
}

/** Whether `.env` content carries a non-empty ACTIVE value for `name`. */
function hasActiveEnvValue(content: string, name: string): boolean {
  return (parseEnvContent(content).get(name)?.trim() ?? "") !== "";
}

function mentionsEnvName(content: string, name: string): boolean {
  return content.split("\n").some((line) => new RegExp(`^\\s*#?\\s*${name}\\s*=`).test(line));
}

/**
 * Write `entries` into the selected environment's value file, under a `# --- <section> ---` line. A name with a
 * non-empty active value is kept unless `overwrite` names it.
 */
export async function writeValues(
  dir: string,
  section: string,
  entries: readonly ValueEntry[],
  overwrite: readonly string[] = [],
): Promise<ValueWriteResult> {
  const file = dotEnvPath(dir);
  const secretsDir = dirname(file);
  await mkdir(secretsDir, { recursive: true });
  // THE one exception to "fastagent has no opinion about git": the directory it writes secrets into carries its own
  // `.gitignore`.
  const owned = secretsDir === join(dir, SECRETS_DIRNAME) || secretsDir === join(dir, SECRETS_DIRNAME, "production");
  let unprotectedSecretsDir: string | undefined;
  if (owned) {
    // Only EEXIST is tolerable (already protected, or a concurrent writer).
    await writeFile(join(secretsDir, ".gitignore"), baseTemplate("secrets.gitignore"), { flag: "wx" }).catch(
      (e: NodeJS.ErrnoException) => {
        if (e.code !== "EEXIST") throw e;
      },
    );
  } else if (!(await exists(join(secretsDir, ".gitignore")))) {
    unprotectedSecretsDir = secretsDir;
  }
  let current = "";
  try {
    current = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }

  const alreadySet = entries
    .filter((e) => !overwrite.includes(e.name) && hasActiveEnvValue(current, e.name))
    .map((e) => e.name);
  const lines: string[] = [];
  const written: string[] = [];
  const contentLines = current.split("\n");
  let replacedInPlace = false;
  for (const e of entries) {
    if (alreadySet.includes(e.name)) continue;
    if (e.value !== undefined) {
      // An ACTIVE but EMPTY assignment already in the file (an uncommented, unfilled placeholder from `cp
      // .env.example .env`) must be replaced IN PLACE.
      let idx = -1;
      for (let i = contentLines.length - 1; i >= 0; i--) {
        if (parseEnvContent(contentLines[i] as string).has(e.name)) {
          idx = i;
          break;
        }
      }
      if (idx >= 0) {
        contentLines[idx] = `${e.name}=${e.value}`;
        replacedInPlace = true;
      } else {
        lines.push(`${e.name}=${e.value}`);
      }
      written.push(e.name);
    } else if (!mentionsEnvName(current, e.name)) {
      // Hint above, never inline after `=` (this IS the file loadDotEnv reads).
      lines.push(...(e.hint === undefined ? [] : [`# ${e.hint}`]), `# ${e.name}=`);
    }
  }
  // 0600 on the file this call CREATES, and nothing at all about one it did not: a `.env` the operator made with
  // `cp .secrets/.env.example .secrets/.env` carries the mode that command gave it, and re-deciding it would be
  // fastagent changing the permissions of a file it does not own.
  const secret = { mode: SECRET_FILE_MODE } as const;
  if (replacedInPlace) {
    current = contentLines.join("\n");
    await writeFile(file, current, secret);
  }
  if (lines.length > 0) {
    const marker = `# --- ${section} ---`;
    if (current.includes(marker)) {
      // A marker already present (e.g. a .env copied from .env.example) — slot the new lines under it instead of
      // orphaning them at the end of the file.
      await writeFile(file, current.replace(marker, `${marker}\n${lines.join("\n")}`), secret);
    } else {
      const prefix = current === "" ? "" : current.endsWith("\n") ? "\n" : "\n\n";
      await appendFile(file, `${prefix}${marker}\n${lines.join("\n")}\n`, secret);
    }
  }
  return { written, alreadySet, ...(unprotectedSecretsDir === undefined ? {} : { unprotectedSecretsDir }) };
}
