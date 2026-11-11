/**
 * ADDRESSING: which directory is the agent — the one holding `fastagent.config.ts`, named by the caller — plus the
 * machinery paths that follow from it. Nothing about what the agent works on is derived from where it sits; that is
 * its declared content (src/content/).
 */
import { type Stats, statSync } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { DeployHost } from "./deploy/hosts.ts";

/** The user-global machinery home, `~/.fastagent`: the machine's model credentials. */
export function globalHome(): string {
  return join(homedir(), ".fastagent");
}

/**
 * The secrets segment inside an agent dir (or the global home). Every path fastagent resolves — `.env`,
 * `.env.example`, auth.json, the scaffold's write — derives from it, so they cannot drift apart.
 * `FASTAGENT_SECRETS_DIR` relocates the RESOLVED dir ({@link resolveSecretsDir}), never this name; the scaffolded
 * ignore templates spell it out as literal text, so renaming this constant means editing them too.
 */
export const SECRETS_DIRNAME = ".secrets";
export const AGENT_ENVIRONMENT_ENV = "FASTAGENT_ENVIRONMENT";
type AgentEnvironment = "dev" | "production";

export function selectAgentEnvironment(environment: AgentEnvironment, env: NodeJS.ProcessEnv = process.env): void {
  env[AGENT_ENVIRONMENT_ENV] = environment;
}

function environmentPath(dir: string, segment: string, env: NodeJS.ProcessEnv): string {
  const root = join(resolve(dir), segment);
  return env[AGENT_ENVIRONMENT_ENV] === "production" ? join(root, "production") : root;
}

/** The state segment inside an agent dir — same rule and same template caveat as {@link SECRETS_DIRNAME}. */
export const STATE_DIRNAME = ".state";

/**
 * Where fastagent clones the repositories an agent's content declares, `content/<name>` in the instance's working
 * directory. Never an env override: a machine that has a checkout of its own adds it as a directory instead.
 */
export const CONTENT_DIRNAME = "content";

/** The agent's context declaration (`context.json`), beside its config: shared, so only what every instance reaches. */
export const CONTEXT_FILE = "context.json";

/**
 * THE config filename. One spelling, not a family: fastagent generates this file, so a choice of extension buys
 * an author nothing and costs a precedence order plus a "you have two of them" failure path. Everything else an
 * author writes (`tools/`, `channels/`) still accepts `.ts`/`.js`/`.mjs` — that is THEIR code.
 */
export const AGENT_CONFIG_FILE = "fastagent.config.ts";
/** The instance configuration a development project holds beside its `fastagent.config.ts`. */
export const INSTANCE_CONFIG_FILE = "fastagent.json";

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
        "or create one with `fastagent init <dir>`",
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

/**
 * A path as an instance configuration writes it, absolute: `~/` is the home directory, a relative one is `base`'s (the
 * configuration file's directory). Undefined for a relative one when there is no file to anchor it.
 */
export function configurationPath(path: string, base: string | undefined): string | undefined {
  if (path === "~" || path.startsWith("~/")) return join(homedir(), path.slice(1));
  if (isAbsolute(path)) return resolve(path);
  return base === undefined ? undefined : resolve(base, path);
}

/** Where an instance is, from the environment: the root, or its state and its workspace apart (agent-artifact.md §4.1). */
export const INSTANCE_ROOT_ENV = "FASTAGENT_ROOT";
export const INSTANCE_WORKDIR_ENV = "FASTAGENT_WORKDIR";
export const INSTANCE_STATE_ENV = "FASTAGENT_STATE_DIR";
export const INSTANCE_CONFIG_ENV = "FASTAGENT_CONFIG";
/** The instance configuration as the JSON itself, which a deploy sets on a box that has no file for it. */
export const INSTANCE_CONFIG_JSON_ENV = "FASTAGENT_CONFIG_JSON";

/** Where fastagent keeps what it makes for a local instance of the project in `dir`, one directory per environment. */
export const INSTANCES_DIRNAME = ".fastagent";

/**
 * The instance root of the project in `dir` when none is given (agent-artifact.md §4.1): `.fastagent/dev/` for `dev`,
 * and `.fastagent/start/` for the commands that run what `start` runs, kept apart so a trial of the production build
 * never reads or writes the development sessions and clones.
 */
function defaultInstanceRoot(dir: string, env: NodeJS.ProcessEnv): string {
  return join(resolve(dir), INSTANCES_DIRNAME, env[AGENT_ENVIRONMENT_ENV] === "production" ? "start" : "dev");
}

/**
 * The resolved state root — the durable machine-state home (sessions/, channels/<kind>/, schedule/): the state
 * directory, else `.state` in the instance root, which is the project's default one when none is given.
 */
export function resolveStateRoot(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  return (
    resolveOverridePath(env[INSTANCE_STATE_ENV]) ??
    join(resolveOverridePath(env[INSTANCE_ROOT_ENV]) ?? defaultInstanceRoot(dir, env), STATE_DIRNAME)
  );
}

/** The agent's working directory: the workspace directory, else the instance root, which is the project's default one. */
export function resolveWorkdir(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  return (
    resolveOverridePath(env[INSTANCE_WORKDIR_ENV]) ??
    resolveOverridePath(env[INSTANCE_ROOT_ENV]) ??
    defaultInstanceRoot(dir, env)
  );
}

/** Where fastagent clones the content entry `name` of the agent in `dir`. */
export function contentEntryPath(dir: string, name: string): string {
  return join(resolve(dir), CONTENT_DIRNAME, name);
}

/**
 * The resolved secrets dir — everything fastagent manages that must NEVER leave the machine (the agent's `.env` +
 * auth.json). Explicit paths win; production otherwise uses `.secrets/production`, dev uses `.secrets`.
 */
export function resolveSecretsDir(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolveOverridePath(env.FASTAGENT_SECRETS_DIR) ?? environmentPath(dir, SECRETS_DIRNAME, env);
}

/** The release a deploy started on the box: set on the host with the instance's name, read when the storage is taken. */
export const RELEASE_ID_ENV = "FASTAGENT_RELEASE_ID";

/**
 * Set by the generated image itself, so a platform variable that is edited or deleted cannot turn a deployed box into
 * a local-looking one that skips the storage's mount check. Its presence is what tells `start` to take the deployment's
 * storage, and the variables that name the release are then required.
 */
export const DEPLOYED_ENV = "FASTAGENT_DEPLOYED";

/** Is this process the deployed container the generated artifacts describe? ONE reading of the
 *  environment fact the image states, so a second spelling cannot drift from it. */
export function isDeployedWorkspace(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[DEPLOYED_ENV]);
}

/** Is this process running inside the AgentCore Runtime? Set by the generated deploy artifacts. */
export function isAgentcoreRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FASTAGENT_AGENTCORE === "1";
}

/**
 * Which host this deployed box runs on, for the command that logs it in (`login --deployment <host>`). Read from what
 * each platform puts in a box's environment (`FLY_APP_NAME`, `RAILWAY_SERVICE_ID`) or what our AgentCore template
 * sets, because the artifacts in the agent directory cannot say it: a Railway deploy leaves no file of its own, and a
 * directory can hold several hosts' files. Undefined where nothing says (Docker sets nothing, nor would a host
 * fastagent did not deploy to): the caller then asks for the host by name.
 */
export function deployedHost(env: NodeJS.ProcessEnv = process.env): DeployHost | undefined {
  if (env.FASTAGENT_AGENTCORE === "1") return "agentcore";
  if (env.FLY_APP_NAME) return "fly";
  if (env.RAILWAY_SERVICE_ID) return "railway";
  return undefined;
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

/** Guard that `<agentDir>/<name>` resolves INSIDE the agent dir. */
export async function assertInsideAgentDir(agentDir: string, name: string): Promise<void> {
  const target = join(agentDir, name);
  const real = await realpath(target).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT" || e.code === "not_found") return undefined;
    throw e;
  });
  if (real === undefined) return;
  const root = await realpath(agentDir).catch(() => resolve(agentDir));
  const rel = relative(root, real);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `${target} resolves outside the agent dir (${real}) — it must live inside the definition directory; ` +
        `use a real directory or a symlink that stays within it`,
    );
  }
}

/** Whether `targetPath` lives inside `baseDir` (same path counts). */
export function isUnderDir(targetPath: string, baseDir: string): boolean {
  const rel = relative(baseDir, targetPath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
