/**
 * ADDRESSING: which directory is the agent — the one holding `fastagent.config.ts`, named by the caller — plus the
 * machinery paths that follow from it.
 */
import { type Stats, statSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/** The user-global machinery home, `~/.fastagent`: the machine's model credentials. */
export function globalHome(): string {
  return join(homedir(), ".fastagent");
}

/**
 * The secrets segment inside an agent dir (or the global home). Every path fastagent resolves — `.env`,
 * `.env.example`, auth.json, the scaffold's write — derives from it, so they cannot drift apart. The scaffolded
 * ignore templates spell it out as literal text, so renaming this constant means editing them too.
 */
export const SECRETS_DIRNAME = ".secrets";

/** The state segment inside an agent dir — same rule and same template caveat as {@link SECRETS_DIRNAME}. */
export const STATE_DIRNAME = ".state";

/**
 * THE config filename. One spelling, not a family: fastagent generates this file, so a choice of extension buys
 * an author nothing and costs a precedence order plus a "you have two of them" failure path. Everything else an
 * author writes (`src/tools/`, `src/extensions/`) still accepts `.ts`/`.js`/`.mjs` — that is THEIR code.
 */
export const AGENT_CONFIG_FILE = "fastagent.config.ts";

/**
 * "Not there" and "could not look" are different answers, and only the first may read as an absence: an agent
 * directory the caller cannot enter (EACCES) reported as no-agent-here ends in `run \`fastagent init\`` — over a
 * definition that exists. So ENOENT/ENOTDIR are absence, and every other errno travels with its path.
 */
function statOrAbsent(p: string): Stats | undefined {
  try {
    return statSync(p);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw e;
  }
}

/** THE marker: a directory that declares itself an agent with a {@link AGENT_CONFIG_FILE}. */
function hasConfig(p: string): boolean {
  return statOrAbsent(p)?.isDirectory() === true && statOrAbsent(join(p, AGENT_CONFIG_FILE)) !== undefined;
}

/** The agent `dir` sits INSIDE (the nearest proper ancestor that IS an agent dir), or undefined. */
export function enclosingAgentDir(dir: string): string | undefined {
  let candidate = dirname(resolve(dir));
  for (let prev = ""; candidate !== prev; prev = candidate, candidate = dirname(candidate)) {
    if (hasConfig(candidate)) return candidate;
  }
  return undefined;
}

/**
 * The agent directory `dir` names, for a command that also works without one (`login`, `models`): `dir` itself when it
 * holds the config, undefined when it is no agent and inside none. Inside an agent is refused, naming its root —
 * answering for the enclosing agent would act on a directory the caller did not name, and answering "no agent" would
 * send a login to the machine's store.
 */
export function findAgentDir(dir: string): string | undefined {
  const base = resolve(dir);
  if (hasConfig(base)) return base;
  const enclosing = enclosingAgentDir(base);
  if (enclosing) {
    throw new Error(`${base} is inside the agent ${enclosing} — run from ${enclosing}, or pass it as the agent`);
  }
  return undefined;
}

/** The agent directory `dir` names ({@link findAgentDir}), refusing when there is none. */
export function resolveAgentDir(dir: string): string {
  const agentDir = findAgentDir(dir);
  if (agentDir === undefined) {
    throw new Error(
      `${resolve(dir)} is not a fastagent agent — it holds no ${AGENT_CONFIG_FILE}; pass the agent's directory, ` +
        "or initialize one with `fastagent init` (or `fastagent init <dir>`)",
    );
  }
  return agentDir;
}

/** How to WRITE a path for someone standing in `cwd`. */
export function displayPath(cwd: string, dir: string): string | undefined {
  const rel = relative(cwd, dir);
  if (rel === "") return undefined;
  // "Climbs out" is a path-SEGMENT check — rel is ".." or starts with "../" (or "..\" on Windows).
  const escapes = rel === ".." || /^\.\.[/\\]/.test(rel);
  return escapes ? dir : rel;
}

export async function exists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}

/** The file's text, or undefined when there is no file. */
export async function readTextIfExists(p: string): Promise<string | undefined> {
  try {
    return await readFile(p, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Resolve a user-supplied path override (a CLI flag or an env var) to an absolute path, expanding a leading `~`/`~/`
 * to the home dir FIRST.
 */
export function resolveOverridePath(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const expanded = raw === "~" ? homedir() : raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
  return resolve(expanded);
}

/** Where an instance is, from the environment: its root, the agent's working directory with its state inside. */
export const INSTANCE_ROOT_ENV = "FASTAGENT_ROOT";

/**
 * The PostgreSQL database an instance's sessions live in, instead of its own `agent.sqlite`. Instances share it, each
 * under the name it is given (`FASTAGENT_NAME`): there is no default, so two never meet by accident.
 */
export const DATABASE_URL_ENV = "FASTAGENT_DATABASE_URL";

/** Where fastagent keeps what it makes for a local instance of the project in `dir`, one directory per environment. */
export const INSTANCES_DIRNAME = ".fastagent";

/** Local instance directory under `.fastagent/`: `dev` for development, `start` for local build trials. */
export type InstanceMode = "dev" | "start";

/**
 * The instance root of the project in `dir` when none is given: `.fastagent/dev/` for `dev` and one-shot commands,
 * and `.fastagent/start/` for `start`, kept apart so a trial of the production build never reads or writes dev sessions.
 */
function defaultInstanceRoot(dir: string, mode: InstanceMode): string {
  return join(resolve(dir), INSTANCES_DIRNAME, mode);
}

/** The agent's working directory: the instance root, else the project's default one. */
export function resolveWorkdir(dir: string, env: NodeJS.ProcessEnv = process.env, mode: InstanceMode = "dev"): string {
  return resolveOverridePath(env[INSTANCE_ROOT_ENV]) ?? defaultInstanceRoot(dir, mode);
}

/** The durable machine-state home (sessions and instance state): `.state` in the instance root. */
export function resolveStateRoot(
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
  mode: InstanceMode = "dev",
): string {
  return join(resolveWorkdir(dir, env, mode), STATE_DIRNAME);
}

/** The agent's secrets directory (`.secrets`), which must never leave the machine. */
export function resolveSecretsDir(dir: string): string {
  return join(resolve(dir), SECRETS_DIRNAME);
}

/**
 * Set by the generated image itself, so a platform variable that is edited or deleted cannot turn a deployed box into
 * a local-looking one that skips the storage's mount check. Its presence is what tells `start` to take the deployment's
 * storage, and `FASTAGENT_NAME` is then required.
 */
export const DEPLOYED_ENV = "FASTAGENT_DEPLOYED";

/** Is this process the deployed container the generated artifacts describe? ONE reading of the
 *  environment fact the image states, so a second spelling cannot drift from it. */
export function isDeployedWorkspace(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[DEPLOYED_ENV]);
}

/**
 * The mode of a file fastagent CREATES to hold a secret: `auth.json`, a `.env` it makes itself,
 * a host's parameter file. That is the whole extent of its opinion about permissions — a file it did not create
 * keeps the mode its owner gave it, and no directory's mode is ever decided or repaired. Every comparable tool
 * draws the line here: Rails chmods the `master.key` it generates and leaves `config/` alone
 * (rails/rails@4c6c357), the aws CLI ships a 0600 `~/.aws/config` inside a 0755 `~/.aws`.
 *
 * "Who created the file" is the load-bearing half: asking instead whether a given WRITE carries a secret has a
 * different answer at every call site and one more with each new writer.
 *
 * One consequence worth knowing: `writeFileAtomic` sets the mode on the temp file it renames into place, so a
 * file it owns end-to-end (`auth.json`) is 0600 after every write, including one an operator had
 * placed by hand. Appending to a file fastagent did not create (`.env`) cannot and does not do that.
 */
export const SECRET_FILE_MODE = 0o600;

/** Whether `targetPath` lives inside `baseDir` (same path counts). */
export function isUnderDir(targetPath: string, baseDir: string): boolean {
  const rel = relative(baseDir, targetPath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
