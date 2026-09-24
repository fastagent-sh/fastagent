/**
 * PLACEMENT: which directory holds the agent, and which directory the agent works ON — plus the machinery paths that
 * follow from it.
 */
import { type Dirent, type Stats, readdirSync, statSync } from "node:fs";
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
 * author writes (`tools/`, `channels/`, `routines/`) still accepts `.ts`/`.js`/`.mjs` — that is THEIR code.
 */
export const AGENT_CONFIG_FILE = "fastagent.config.ts";

/** The optional custom-model-endpoint file inside an agent dir (pi's models.json schema). */
export const AGENT_MODELS_FILE = "models.json";

export interface ResolvedPlacement {
  /**
   * The AGENT directory — where the definition (persona.md/skills/tools/channels/routines), the config, and the
   * machinery dirs (`.secrets/`, `.state/`) live.
   */
  agentDir: string;
  /**
   * The WORKSPACE — what the agent works ON: its cwd, and the start of the ② context walk. Always the agent
   * directory's parent, whichever of the two the command was pointed at.
   */
  workspace: string;
}

/**
 * The definition paths an agent LOADS content from — the surface a second agent must not be scaffolded inside
 * ({@link agentDefinitionOwner}), because the outer agent would read it as its own skills/tools.
 */
const LOADED_SURFACE = ["persona.md", "skills", "tools", "channels", "routines"] as const;

/**
 * "Not there" and "could not look" are different answers, and only the first may read as an absence: an agent
 * directory the caller cannot enter (EACCES) reported as no-agent-here ends in `run \`fastagent init\` to
 * scaffold one` — over a definition that exists. So ENOENT/ENOTDIR are absence, and every other errno travels
 * with its path, as {@link agentChildren} already did for the scan itself.
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

function isDir(p: string): boolean {
  return statOrAbsent(p)?.isDirectory() === true;
}

/** THE marker: a directory that declares itself an agent with a {@link AGENT_CONFIG_FILE}. */
function hasConfig(p: string): boolean {
  return isDir(p) && statOrAbsent(join(p, AGENT_CONFIG_FILE)) !== undefined;
}

/**
 * DIRECTLY inside `dir`: the agent directories, and the ones the answer is missing for.
 *
 * A NAMED directory and a SCANNED one are different questions. `hasConfig` throws for the first, because the
 * caller pointed at it. Here it cannot: every machine has directories this process may not enter, and one of
 * them sitting next to the agent must not fail a command that found the agent — `workspaceHint` scans the
 * PARENT for a hint, which on a CI runner means scanning `/tmp` and its `snap-private-tmp`. So an unreadable
 * candidate is carried, not thrown, and {@link resolvePlacement} spends it where it is the answer: a caller
 * that must produce an agent and found none says "I could not look at these", never `fastagent init`.
 */
function agentChildren(dir: string): { agents: string[]; unreadable: string[] } {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { agents: [], unreadable: [] };
    throw e;
  }
  const agents: string[] = [];
  const unreadable: string[] = [];
  for (const entry of entries.filter((e) => !e.isFile())) {
    const child = join(dir, entry.name);
    try {
      if (hasConfig(child)) agents.push(child);
    } catch (e) {
      // PERMISSION ONLY. "Someone else's 0700 directory sits next to mine" is the normal case this carrying
      // exists for, and it is the one an operator can act on. EIO, ELOOP, a non-errno throw: those are real
      // failures with different fixes, and a scan has no business turning them into a line of prose.
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EACCES" && code !== "EPERM") throw e;
      unreadable.push(entry.name);
    }
  }
  return { agents: agents.sort(), unreadable: unreadable.sort() };
}

/**
 * The agents `dir` resolves over: ITSELF when it holds a config, else the ones directly inside it — never both,
 * because aiming at an agent can only mean that agent.
 */
export function agentsAt(dir: string): string[] {
  return scanAgents(resolve(dir)).agents;
}

/** {@link agentsAt} plus what the scan could not look at — one readdir answering both questions. */
function scanAgents(base: string): { agents: string[]; unreadable: string[] } {
  return hasConfig(base) ? { agents: [base], unreadable: [] } : agentChildren(base);
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
  const agentDir = selectAgent(agentsAt(resolve(dir)), env);
  return agentDir === undefined ? undefined : { agentDir, workspace: dirname(agentDir) };
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
      `FASTAGENT_AGENT=<name>, or point fastagent at the one you want`
    );
  }
  return undefined;
}

/**
 * Resolve a directory into its placement — the ONE owner of the rule ({@link findPlacement}).
 *
 * WHERE AN UNREADABLE CANDIDATE IS SPENT, and only here: this caller MUST produce an agent, so a directory it
 * could not look into is the difference between "there is none" and "there might be". `placementDeadEnd` is
 * asked a weaker question — is this place a dead end with its own way out — by callers like `login`, for which
 * a neighbour it may not enter is environment noise, not a reason to exit instead of logging in globally. It
 * also comes AFTER that call: with two agents to choose between, a permission problem in a third directory is
 * not the message that gets the caller moving.
 */
export function resolvePlacement(dir: string, env: NodeJS.ProcessEnv = process.env): ResolvedPlacement {
  const placement = findPlacement(dir, env);
  if (!placement) {
    const base = resolve(dir);
    throw new Error(placementDeadEnd(base, env) ?? `${base} is not a fastagent agent${noAgentHere(base)}`);
  }
  return placement;
}

/** At most this many names before the rest become a count — `/tmp` on a shared machine has plenty. */
const LISTED_UNREADABLE = 3;

/**
 * The rest of the "not an agent" refusal: the way out, plus what could not be looked at.
 *
 * BOTH, never one or the other. `fastagent init` is the only line that tells the caller what to do, and a
 * directory it cannot enter is exactly why that advice can be wrong (#571: scaffolding over a definition that
 * is there but invisible). Substituting the second for the first sends anyone running in `/tmp`, or on a
 * shared machine, to fix permissions on directories that were never theirs and hold no agent.
 */
function noAgentHere(base: string): string {
  const { unreadable } = scanAgents(base);
  const noConfig = ` — no fastagent.config.ts here, and no readable directory holding one directly inside`;
  const scaffold = "run `fastagent init` to scaffold one";
  if (unreadable.length === 0) return `${noConfig}; ${scaffold}`;
  const shown = unreadable.slice(0, LISTED_UNREADABLE).join(", ");
  const rest = unreadable.length - LISTED_UNREADABLE;
  // The unknown FIRST, because it is the one thing that can make the advice wrong.
  return (
    `${noConfig}. ${unreadable.length} director${unreadable.length === 1 ? "y" : "ies"} here could not be ` +
    `read (permission), so an agent may be inside one: ${shown}${rest > 0 ? `, +${rest} more` : ""}. Check ` +
    `those first; ${scaffold} only if none of them holds an agent`
  );
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
 * The resolved state root — the durable machine-state home (sessions/, channels/<kind>/, schedule/):
 * `FASTAGENT_STATE_DIR` env > `<agentDir>/.state`.
 */
export function resolveStateRoot(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolveOverridePath(env.FASTAGENT_STATE_DIR) ?? join(resolve(dir), STATE_DIRNAME);
}

/**
 * WHERE an agent's session records live: `<state root>/sessions`, always. Records are machine state like channel
 * state and schedule claims, so they move with the ONE knob that moves all of it rather than with a second one that
 * moves only them — a split every reader would then have to agree about, and which left channel state behind anyway.
 * An embedder that really wants the records elsewhere passes `sessionsDir` to `createAgentService`; there is no env
 * or flag spelling of it, for the reason `resolveAuthPathOverride` states.
 */
export function resolveSessionsDir(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveStateRoot(dir, env), "sessions");
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
 * The mode of a file fastagent CREATES to hold a secret: `auth.json`, a `.env` it makes itself,
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
