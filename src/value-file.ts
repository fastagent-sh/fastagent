/**
 * The selected environment's value file (`.secrets/.env`, or `.secrets/production/.env` for `start`), read and
 * written; entering it into `process.env` is env.ts's. Read as data: what it declares, and what it adds to an agent's
 * environment. Written: what a command generates (a channel's secret, the Agent API's key) goes in as an active
 * `NAME=value` line, a value already set stays, and the secrets directory fastagent made carries its own `.gitignore`.
 */
import { readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { GitNotInstalled, gitFor } from "./git.ts";
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

/**
 * The value file this process's command was told to use (`--env-file`). Process state set at the command's entry, not
 * an environment variable: a variable would be read from a shell, by commands that never took the flag, and by what
 * the agent runs. A `dev` worker is spawned with its supervisor's arguments and takes the flag itself.
 */
let selectedValueFile: string | undefined;
/** Per process: a command sets it at its entry, and a command that does not (`add`, `models`) runs with the default. */
let defaultValueFile = true;

/**
 * Use `path` as the agent's value file from here on, or the default again. `defaultFile: false` is for a command that
 * runs a deployment (`deploy`, `secrets`, `destroy`, `logs`, `login --deployment`, `invoke --url`): it has no default
 * file, only the one `--env-file` names, and otherwise the environment it runs in (what a CI job or `op run` injects).
 */
export function useValueFile(path: string | undefined, options: { defaultFile?: boolean } = {}): void {
  selectedValueFile = path;
  defaultValueFile = options.defaultFile ?? true;
}

/** The file `--env-file` named, when one was: the only file a deployment's values may come from. */
export function namedValueFile(): string | undefined {
  return selectedValueFile;
}

/** The file this command reads values from, when it has one: the default's, or only `--env-file`'s (see {@link useValueFile}). */
export function valueFileOf(agentDir: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return defaultValueFile ? dotEnvPath(agentDir, env) : selectedValueFile;
}

/** The agent's `.env` file: the one `--env-file` named, else `<resolved secrets dir>/.env`. */
export function dotEnvPath(agentDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return selectedValueFile ?? join(resolveSecretsDir(agentDir, env), ".env");
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

/**
 * Whether `file`, inside the agent directory `dir`, is a secret git would track: the directory is a checkout and the file
 * is not ignored. A name like `prod.env` is matched by no rule the scaffold's `.gitignore` writes, and fastagent does not
 * edit a `.gitignore` it did not make, so the person is told. Not a checkout, a file outside the directory (its own
 * place to protect), or no git at all: nothing to say, since there is nothing git could commit.
 */
export function trackedValueFile(dir: string, file: string): boolean {
  const rel = relative(dir, file);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
  const git = gitFor("check that a value file is not committed");
  try {
    if (git.answer(["rev-parse", "--is-inside-work-tree"], dir) !== "true") return false;
    // `check-ignore -q` exits 0 for an ignored path and 1 for one that is not: `answer` reads the first as a value.
    return git.answer(["check-ignore", "-q", rel], dir) === undefined;
  } catch (error) {
    if (error instanceof GitNotInstalled) return false;
    throw error;
  }
}

/** What a command says of a value file in the agent directory that git does not ignore. */
export function trackedValueFileNote(file: string): string {
  return (
    `${file} holds secrets and is not ignored by git: add it to .gitignore (or keep it outside the agent directory), ` +
    "or it can be committed. fastagent does not edit a .gitignore it did not write."
  );
}

export interface ValueWriteResult {
  /** Generated values written as active `NAME=value` lines. */
  written: string[];
  /** Vars already present with a non-empty active value; left untouched and omitted from next steps. */
  alreadySet: string[];
  /** Set when the secrets dir is an operator-chosen one (`FASTAGENT_SECRETS_DIR`) carrying no `.gitignore`. */
  unprotectedSecretsDir?: string;
  /** Set when the file itself is in the agent directory and git would track it (`trackedValueFile`). */
  trackedFile?: string;
}

/**
 * What a command says when it wrote a secret into a secrets directory fastagent does not own and git may track; `chosenBy`
 * is what put the secrets there (the operator's `FASTAGENT_SECRETS_DIR`, unless the caller knows better).
 */
export function unprotectedSecretsNote(dir: string, chosenBy = "FASTAGENT_SECRETS_DIR"): string {
  return (
    `${dir} (${chosenBy}) now holds a secret and has no .gitignore — that directory is yours, so ` +
    "fastagent will not write one into it. Make sure git does not track what is in there."
  );
}

export async function prepareSecretsDirectory(dir: string, secretsDir: string): Promise<string | undefined> {
  await mkdir(secretsDir, { recursive: true });
  const owned = secretsDir === join(dir, SECRETS_DIRNAME) || secretsDir === join(dir, SECRETS_DIRNAME, "production");
  if (owned) {
    // EEXIST preserves an existing ignore file, including one created by a concurrent writer.
    await writeFile(join(secretsDir, ".gitignore"), baseTemplate("secrets.gitignore"), { flag: "wx" }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      },
    );
  } else if (!(await exists(join(secretsDir, ".gitignore")))) {
    return secretsDir;
  }
}

/** Whether `.env` content carries a non-empty ACTIVE value for `name`. */
function hasActiveEnvValue(content: string, name: string): boolean {
  return (parseEnvContent(content).get(name)?.trim() ?? "") !== "";
}

function mentionsEnvName(content: string, name: string): boolean {
  return content.split("\n").some((line) => new RegExp(`^\\s*#?\\s*${name}\\s*=`).test(line));
}

/**
 * Write `entries` into `file` (default: the selected environment's value file), under a `# --- <section> ---` line. A
 * name with a non-empty active value is kept unless `overwrite` names it.
 */
export async function writeValues(
  dir: string,
  section: string,
  entries: readonly ValueEntry[],
  overwrite: readonly string[] = [],
  file: string = dotEnvPath(dir),
): Promise<ValueWriteResult> {
  const unprotectedSecretsDir = await prepareSecretsDirectory(dir, dirname(file));
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
  // The directory's own `.gitignore` is the answer for a secrets dir; for the agent directory it names other files, so
  // the file is asked about. Checked after the write, which is what makes it a secret there.
  const trackedFile = unprotectedSecretsDir === undefined && trackedValueFile(dir, file) ? file : undefined;
  return {
    written,
    alreadySet,
    ...(unprotectedSecretsDir === undefined ? {} : { unprotectedSecretsDir }),
    ...(trackedFile === undefined ? {} : { trackedFile }),
  };
}
