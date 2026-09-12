/**
 * PLACEMENT: which directory holds the agent, and which directory the agent works ON — plus the machinery paths that
 * follow from it.
 */
import { type Dirent, existsSync, readdirSync, statSync } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** The directory name `init` gives a nested agent (`<workspace>/fastagent/`) unless `--agent-dir` names another. */
export const DEFAULT_AGENT_DIRNAME = "fastagent";

/** The user-global machinery home under `$HOME`. */
export const GLOBAL_HOME_DIR = ".fastagent";

/**
 * The secrets segment inside an agent dir (or the global home). Every path fastagent resolves — `.env`,
 * `.env.example`, auth.json, the scaffold's write — derives from it, so they cannot drift apart.
 * `FASTAGENT_SECRETS_DIR` relocates the RESOLVED dir ({@link resolveSecretsDir}), never this name; the scaffolded
 * ignore templates spell it out as literal text, so renaming this constant means editing them too.
 */
export const SECRETS_DIRNAME = ".secrets";

/** The state segment inside an agent dir — same rule and same template caveat as {@link SECRETS_DIRNAME}. */
export const STATE_DIRNAME = ".state";

/**
 * THE config filename. One spelling, not a family: fastagent generates this file, so a choice of extension buys
 * an author nothing and costs a precedence order plus a "you have two of them" failure path. Everything else an
 * author writes (`tools/`, `channels/`, `schedules/`) still accepts `.ts`/`.js`/`.mjs` — that is THEIR code.
 */
export const AGENT_CONFIG_FILE = "fastagent.config.ts";

/** The optional custom-model-endpoint file inside an agent dir (pi's models.json schema). */
export const AGENT_MODELS_FILE = "models.json";

export interface ResolvedPlacement {
  /**
   * The AGENT directory — where the definition (persona.md/skills/tools/channels/schedules), the config, and the
   * machinery dirs (`.secrets/`, `.state/`) live.
   */
  agentDir: string;
  /** The WORKSPACE — what the agent works ON: its cwd, and the start of the ② context walk. */
  workspace: string;
}

/**
 * The definition paths an agent LOADS content from — the surface a second agent must not be scaffolded inside
 * ({@link agentDefinitionOwner}), because the outer agent would read it as its own skills/tools.
 */
const LOADED_SURFACE = ["persona.md", "skills", "tools", "channels", "schedules"] as const;

function isDir(p: string): boolean {
  return statSync(p, { throwIfNoEntry: false })?.isDirectory() === true;
}

/** THE marker: a directory that declares itself an agent with a {@link AGENT_CONFIG_FILE}. */
function hasConfig(p: string): boolean {
  return isDir(p) && existsSync(join(p, AGENT_CONFIG_FILE));
}

/** The agent directories DIRECTLY inside `dir` — the one-level scan that finds an agent without knowing its name. */
function agentChildren(dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw e;
  }
  return entries
    .filter((e) => !e.isFile() && hasConfig(join(dir, e.name)))
    .map((e) => join(dir, e.name))
    .sort();
}

/**
 * The agents `dir` resolves over: ITSELF when it holds a config, else the ones directly inside it — never both,
 * because aiming at an agent can only mean that agent.
 */
export function agentsAt(dir: string): string[] {
  const base = resolve(dir);
  return hasConfig(base) ? [base] : agentChildren(base);
}

/** WHICH agent is meant, when a directory holds several. */
function selectAgent(agents: string[], env: NodeJS.ProcessEnv): string | undefined {
  const wanted = env.FASTAGENT_AGENT;
  if (wanted) return agents.find((a) => basename(a) === wanted);
  const [only, ...rest] = agents;
  return rest.length === 0 ? only : agents.find((a) => basename(a) === DEFAULT_AGENT_DIRNAME);
}

/** Resolve `dir` into its placement, or undefined when nothing selects one agent. */
function findPlacement(dir: string, env: NodeJS.ProcessEnv = process.env): ResolvedPlacement | undefined {
  const base = resolve(dir);
  const agentDir = selectAgent(agentsAt(base), env);
  return agentDir === undefined ? undefined : { agentDir, workspace: base };
}

/** The one-line hint for "you pointed at the agent, but the project around it is what you meant" — or undefined. */
export function workspaceHint(
  { agentDir, workspace }: ResolvedPlacement,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (agentDir !== workspace) return undefined;
  const parent = dirname(agentDir);
  if (parent === agentDir) return undefined;
  // Would `..` actually serve THIS agent?
  if (findPlacement(parent, env)?.agentDir !== agentDir) return undefined;
  if (!["AGENTS.md", ".git"].some((name) => existsSync(join(parent, name)))) return undefined;
  return `${parent} looks like a project — point fastagent at it (\`..\`) to have the agent work ON it`;
}

/** The agent dir for `dir`, or undefined when there is none — {@link findPlacement} without the pair or the throw. */
export function findAgentDir(dir: string): string | undefined {
  return findPlacement(dir)?.agentDir;
}

/** The agent `dir` sits INSIDE (the nearest proper ancestor that IS an agent dir), or undefined. */
function enclosingAgentDir(dir: string): string | undefined {
  let candidate = dirname(resolve(dir));
  for (let prev = ""; candidate !== prev; prev = candidate, candidate = dirname(candidate)) {
    if (hasConfig(candidate)) return candidate;
  }
  return undefined;
}

/**
 * The agent whose DEFINITION contains `dir` — scaffolding there would make the new agent part of the outer one's
 * loaded surface rather than an agent of its own.
 */
export function agentDefinitionOwner(dir: string): string | undefined {
  const base = resolve(dir);
  const agent = enclosingAgentDir(base);
  if (!agent) return undefined;
  const [head] = relative(agent, base).split(sep);
  return head && (LOADED_SURFACE as readonly string[]).includes(head) ? agent : undefined;
}

/** Why `dir` is not an agent, when it has its OWN way out — or undefined when it is simply not near one. */
export function placementDeadEnd(dir: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const base = resolve(dir);
  const enclosing = enclosingAgentDir(base);
  if (enclosing) {
    return `${base} is inside the agent ${enclosing} but is not its root — \`cd\` there (or to its workspace) and re-run`;
  }
  const agents = agentsAt(base).map((a) => basename(a));
  const listed = `${base} holds ${agents.length} agent${agents.length === 1 ? "" : "s"} (${agents.join(", ")})`;
  // Asserting a name that is not here is a different mistake from asserting none, and it is worth its own message at
  // ANY count.
  if (env.FASTAGENT_AGENT && agents.length > 0) {
    return (
      `${listed}, and FASTAGENT_AGENT asserts "${env.FASTAGENT_AGENT}", which is not one of them — set it ` +
      `to one of those, unset it, or scope it to the repository that needs it (an .envrc)`
    );
  }
  if (agents.length > 1) {
    return (
      `${listed} and none of them is named "${DEFAULT_AGENT_DIRNAME}" (the default) — pick one with ` +
      `FASTAGENT_AGENT=<name>, or point fastagent at the one you want (it then works on ITSELF)`
    );
  }
  return undefined;
}

/** Resolve a directory into its placement — the ONE owner of the rule ({@link findPlacement}). */
export function resolvePlacement(dir: string, env: NodeJS.ProcessEnv = process.env): ResolvedPlacement {
  const placement = findPlacement(dir, env);
  if (!placement) {
    const base = resolve(dir);
    throw new Error(
      placementDeadEnd(base, env) ??
        `${base} is not a fastagent agent — no fastagent.config.ts here, and no directory holding one ` +
          `directly inside; run \`fastagent init\` to scaffold one`,
    );
  }
  return placement;
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
 * The resolved state root — the durable machine-state home (sessions/, channels/<kind>/, schedule/, control.json):
 * `FASTAGENT_STATE_DIR` env > `<agentDir>/.state`.
 */
export function resolveStateRoot(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolveOverridePath(env.FASTAGENT_STATE_DIR) ?? join(resolve(dir), STATE_DIRNAME);
}

/**
 * The resolved secrets dir — everything fastagent manages that must NEVER leave the machine (the agent's `.env` +
 * auth.json).
 */
export function resolveSecretsDir(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolveOverridePath(env.FASTAGENT_SECRETS_DIR) ?? join(resolve(dir), SECRETS_DIRNAME);
}

/** Is this process the deployed container the generated artifacts describe? ONE reading of the
 *  environment fact the image states, so a second spelling cannot drift from it. */
export function isDeployedWorkspace(): boolean {
  return Boolean(process.env.FASTAGENT_RELEASE_FILE);
}

/** Is this process running inside the AgentCore Runtime? Set by the generated deploy artifacts. */
export function isAgentcoreRuntime(): boolean {
  return process.env.FASTAGENT_AGENTCORE === "1";
}

/**
 * The mode of a file fastagent CREATES to hold a secret: `auth.json`, a `.env` it makes itself, `control.json`,
 * a host's parameter file. That is the whole extent of its opinion about permissions — a file it did not create
 * keeps the mode its owner gave it, and no directory's mode is ever decided or repaired. Every comparable tool
 * draws the line here: Rails chmods the `master.key` it generates and leaves `config/` alone
 * (rails/rails@4c6c357), the aws CLI ships a 0600 `~/.aws/config` inside a 0755 `~/.aws`.
 *
 * "Who created the file" is the load-bearing half. Asking instead whether a given WRITE carries a secret has a
 * different answer at every call site and one more with each new writer: three rounds of patches went into
 * chmod-ing an existing `.env`, repairing a directory, following a symlink, and reporting an older agent's mode —
 * all for scenarios with no reported use, and none of it reachable under this rule at all.
 *
 * One consequence worth knowing: `writeFileAtomic` sets the mode on the temp file it renames into place, so a
 * file it owns end-to-end (`auth.json`, `control.json`) is 0600 after every write, including one an operator had
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
