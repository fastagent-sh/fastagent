/**
 * PLACEMENT: which directory holds the agent, and which directory the agent works ON — plus the
 * machinery paths that follow from it.
 *
 * ONE marker and ONE rule. `fastagent.config.*` declares an agent; the WORKSPACE is the directory you
 * pointed fastagent at. Nothing here reads a directory NAME, so an agent directory can be called
 * anything — and the same tree answers two ways depending on where you aim it: point at the project and
 * the agent directory inside it answers with the project as its workspace; point at the agent directory
 * itself (all a container may have been shipped) and it works on itself. That is not an ambiguity to
 * resolve but the honest answer — an agent alone on a box has no project to work on, and a rule that
 * insisted otherwise would hand it the container root.
 *
 * Engine-neutral by nature (pure fs/path: existence checks and one shallow scan), so it lives here
 * rather than under engines/pi. Not a filing preference: the scaffold, the deploy planners, the dev
 * watcher and env.ts all need these facts, and routing them through the engine would make neutral
 * modules depend on it for something the engine has no say in.
 */
import { type Dirent, existsSync, readdirSync, statSync } from "node:fs";
import { access, chmod, mkdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * The directory name `init` gives a nested agent (`<workspace>/fastagent/`) unless `--agent-dir` names
 * another. A DEFAULT, not a rule: resolution reads the config marker and never a name, so renaming an
 * agent directory changes nothing about how it resolves. Visible on purpose — the agent directory holds
 * the AUTHOR's content (persona, skills, tool code: code, not tool configuration), so it follows the
 * repo convention for code (a plain directory), while fastagent's own machinery inside it (`.secrets/`,
 * `.state/`) keeps the dot prefix.
 */
export const DEFAULT_AGENT_DIRNAME = "fastagent";

/** The user-global machinery home under `$HOME` — hidden, per the dotfile convention for per-user
 *  tool homes (`~/.cargo`, `~/.docker`); unrelated to {@link DEFAULT_AGENT_DIRNAME}, which only names
 *  what `init` creates.
 *  It carries the same shape inside it as an agent dir does (`~/.fastagent/.secrets/auth.json`), so the
 *  resolvers below need no special case: `login` outside any agent simply hands them this directory. */
export const GLOBAL_HOME_DIR = ".fastagent";

/** The secrets segment inside an agent dir (or the global home): every PATH fastagent resolves —
 *  `.env`, `.env.example`, auth.json, the scaffold's write — derives from it, so they cannot drift
 *  apart. `FASTAGENT_SECRETS_DIR` relocates the RESOLVED dir ({@link resolveSecretsDir}), never this
 *  name. The scaffold's ignore templates are real files the author owns from `init` on, so they spell
 *  their rules out as literal text — renaming this constant means editing them too. */
export const SECRETS_DIRNAME = ".secrets";

/** The state segment inside an agent dir — same rule and same template caveat as {@link SECRETS_DIRNAME}. */
export const STATE_DIRNAME = ".state";

/** The config filenames, in load precedence. ONE source: the loader (below) and `scaffoldAgent`'s
 *  already-an-agent refusal both read this, so "is there a config?" can't diverge between them. */
export const AGENT_CONFIG_NAMES = ["fastagent.config.ts", "fastagent.config.js", "fastagent.config.mjs"] as const;

/** The optional custom-model-endpoint file inside an agent dir (pi's models.json schema). Definition
 *  data, not machinery: it declares WHICH endpoint the agent talks to, so it belongs beside the config
 *  and travels into the deployed image. The name lives HERE, with the other placement facts, because
 *  two neutral readers need it — the loader in engines/pi/models.ts and `dev`'s watcher, whose restart
 *  scope must not silently drift from what the worker actually loads. */
export const AGENT_MODELS_FILE = "models.json";

export interface ResolvedPlacement {
  /** The AGENT directory — where the definition (persona.md/skills/tools/channels/schedules), the
   *  config, and the machinery dirs (`.secrets/`, `.state/`) live. Absolute. */
  agentDir: string;
  /** The WORKSPACE — what the agent works ON: its cwd, and the start of the ② context walk. ALWAYS the
   *  directory fastagent was pointed at, which makes it the agent dir's PARENT when the agent was found
   *  one level down, and the agent dir ITSELF when you aimed straight at it. Absolute.
   *  `agentDir === workspace` is the only discriminant — there is no mode field, because there are no
   *  two placements to distinguish: there is one lookup and the directory you gave it. The naming
   *  follows git: the repository sits at the root of its working tree, and WORK belongs to the tree. */
  workspace: string;
}

/** The definition paths an agent LOADS content from — the surface a second agent must not be scaffolded
 *  inside ({@link agentDefinitionOwner}), because the outer agent would read it as its own skills/tools.
 *  NOT evidence of an agent: `tools/` and `skills/` are ordinary names half the world's repositories
 *  use, and the config is the only marker. */
const LOADED_SURFACE = ["persona.md", "skills", "tools", "channels", "schedules"] as const;

function isDir(p: string): boolean {
  return statSync(p, { throwIfNoEntry: false })?.isDirectory() === true;
}

/** THE marker: a directory that declares itself an agent with a `fastagent.config.*`. One file decides
 *  it, at every position — which is why an agent directory needs no reserved name and why there is no
 *  zero-config agent. */
function hasConfig(p: string): boolean {
  return isDir(p) && AGENT_CONFIG_NAMES.some((name) => existsSync(join(p, name)));
}

/** The agent directories DIRECTLY inside `dir` — the one-level scan that finds an agent without knowing
 *  its name. ONE level: deeper is that directory's own workspace, not this one's agent. Sorted, so a
 *  refusal names them in a stable order. A missing `dir` yields none (callers resolve paths that may not
 *  exist); a permission fault surfaces. */
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
 * The agents `dir` resolves over: ITSELF when it holds a config, else the ones directly inside it —
 * never both, because aiming at an agent can only mean that agent. Exported for `init`, which asks the
 * same question this lookup asks: which agents would `dir` resolve over, before and after scaffolding.
 */
export function agentsAt(dir: string): string[] {
  const base = resolve(dir);
  return hasConfig(base) ? [base] : agentChildren(base);
}

/**
 * WHICH agent is meant, when a directory holds several: an engineer's, a PM's and a content owner's
 * agent can each drive the same repository, so they must be selectable rather than refused.
 *
 * `FASTAGENT_AGENT` reaches this from the REAL environment only. Placement resolves before anything
 * reads the agent's `.env` — it is what tells the loader which agent's `.env` to read — so a value set
 * there is a silent no-op (the same ordering caveat `FASTAGENT_SECRETS_DIR` carries). A shell, an
 * `.envrc`, or the command itself.
 *
 * It is an ASSERTION, not a preference: it names the agent, and a directory without one
 * by that name resolves to nothing — even when exactly one agent is sitting there. Serving a DIFFERENT
 * agent than the one asked for is the silent-wrong-target this codebase refuses everywhere else, and the
 * uniform rule ("it names the agent") beats one that changes meaning with the sibling count. The stated
 * cost: a `FASTAGENT_AGENT` exported in a shell PROFILE refuses in every unrelated directory it travels
 * into. Scope it per-repo (an `.envrc`) or pass it per-command; the refusal names the way out.
 *
 * With nothing asserted, the {@link DEFAULT_AGENT_DIRNAME} breaks the tie. That is the one place a
 * directory NAME carries weight, and deliberately not an identity rule — the config alone says what IS
 * an agent; the name only decides which already-identified one answers. What it buys: adding a second
 * agent to a working `<workspace>/fastagent/` setup does not break the command everyone already types.
 */
function selectAgent(agents: string[], env: NodeJS.ProcessEnv): string | undefined {
  const wanted = env.FASTAGENT_AGENT;
  if (wanted) return agents.find((a) => basename(a) === wanted);
  const [only, ...rest] = agents;
  return rest.length === 0 ? only : agents.find((a) => basename(a) === DEFAULT_AGENT_DIRNAME);
}

/**
 * Resolve `dir` into its placement, or undefined when nothing selects one agent. The whole rule: `dir`
 * is the WORKSPACE, and the agent is a `fastagent.config.*` holder at it or one level inside
 * ({@link agentsAt}), narrowed by {@link selectAgent} when there are several.
 */
function findPlacement(dir: string, env: NodeJS.ProcessEnv = process.env): ResolvedPlacement | undefined {
  const base = resolve(dir);
  const agentDir = selectAgent(agentsAt(base), env);
  return agentDir === undefined ? undefined : { agentDir, workspace: base };
}

/**
 * The one-line hint for "you pointed at the agent, but the project around it is what you meant" — or
 * undefined. The workspace being whatever you aimed at is deliberate (a deployed box may hold nothing
 * but the agent), and the cost is that `cd my-agent && fastagent dev` legitimately narrows the agent's
 * WORKSPACE to its own directory: its cwd, its coding tools' root, and deploy's build context. (②
 * context is not affected — that walk climbs ancestors either way.) Resolution must not guess which you
 * wanted, so this is a HINT — and a hint may use the heuristic ("the parent carries an AGENTS.md or a
 * .git") that a rule may not.
 *
 * It suggests a command only after RUNNING the lookup that command would run, because a hint that dead-ends
 * is worse than none: with several agents beside this one, `..` refuses and names them — sending the
 * reader to a refusal whose own advice points back here.
 */
export function workspaceHint(
  { agentDir, workspace }: ResolvedPlacement,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (agentDir !== workspace) return undefined;
  const parent = dirname(agentDir);
  if (parent === agentDir) return undefined;
  // Would `..` actually serve THIS agent? A parent holding a config is an agent itself, and one holding
  // siblings resolves to none without a selector — neither is the project view asked about here.
  if (findPlacement(parent, env)?.agentDir !== agentDir) return undefined;
  if (!["AGENTS.md", ".git"].some((name) => existsSync(join(parent, name)))) return undefined;
  return `${parent} looks like a project — point fastagent at it (\`..\`) to have the agent work ON it`;
}

/** The agent dir for `dir`, or undefined when there is none — {@link findPlacement} without the pair
 *  or the throw. Login and standalone channel senders also operate outside configured agents, so
 *  they need absence as a value. Filesystem errors still propagate. */
export function findAgentDir(dir: string): string | undefined {
  return findPlacement(dir)?.agentDir;
}

/** The agent `dir` sits INSIDE (the nearest proper ancestor that IS an agent dir), or undefined.
 *  Module-private: the two questions callers actually ask are "where do I `cd` to?"
 *  ({@link placementDeadEnd}) and "would a new agent here become part of an existing one's definition?"
 *  ({@link agentDefinitionOwner}) — and those answers differ (an agent's `src/` is inside it, but is not
 *  part of what it loads), so exporting the raw containment fact would invite conflating them.
 *  Placement resolution deliberately never walks up — the answer must not depend on how deep you stand
 *  — but "you are inside an agent, just not at its root" is the likeliest reason resolution fails, and
 *  both the refusal below and `login`'s global-fallback decision need to tell that case apart. Uses the
 *  same marker as resolution (an ancestor holding a config), so it never claims a position it cannot
 *  justify. */
function enclosingAgentDir(dir: string): string | undefined {
  let candidate = dirname(resolve(dir));
  for (let prev = ""; candidate !== prev; prev = candidate, candidate = dirname(candidate)) {
    if (hasConfig(candidate)) return candidate;
  }
  return undefined;
}

/**
 * The agent whose DEFINITION contains `dir` — scaffolding there would make the new agent part of the
 * outer one's loaded surface rather than an agent of its own. Narrower than {@link enclosingAgentDir} on
 * purpose: an agent owns only what it LOADS ({@link LOADED_SURFACE}); the rest of its directory is the
 * author's tree, where a second agent (a monorepo package, say) is a legitimate thing to create.
 * `enclosingAgentDir` answers a different question ("where do I `cd` to?"), and for that an agent's
 * `src/` genuinely IS inside it.
 */
export function agentDefinitionOwner(dir: string): string | undefined {
  const base = resolve(dir);
  const agent = enclosingAgentDir(base);
  if (!agent) return undefined;
  const [head] = relative(agent, base).split(sep);
  return head && (LOADED_SURFACE as readonly string[]).includes(head) ? agent : undefined;
}

/**
 * Why `dir` is not an agent, when it has its OWN way out — or undefined when it is simply not near one.
 * Two positions qualify: standing INSIDE an agent (its `tools/`, its `src/`), and standing on a
 * directory whose several agents nothing selects between. Both matter because the generic advice ("run
 * `fastagent init`") would not help — the agent already exists, one step away.
 *
 * Exported because `login` is the one command allowed to run outside an agent, and it must tell "truly
 * outside" (→ the global credential) from "a dead end" (→ refuse, like every other command).
 */
export function placementDeadEnd(dir: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const base = resolve(dir);
  const enclosing = enclosingAgentDir(base);
  if (enclosing) {
    return `${base} is inside the agent ${enclosing} but is not its root — \`cd\` there (or to its workspace) and re-run`;
  }
  const agents = agentsAt(base).map((a) => basename(a));
  const listed = `${base} holds ${agents.length} agent${agents.length === 1 ? "" : "s"} (${agents.join(", ")})`;
  // Asserting a name that is not here is a different mistake from asserting none, and it is worth its own
  // message at ANY count: the value sits in the environment (often a shell profile carried in from
  // somewhere else), so echo it back with what is actually here instead of restating the general rule.
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

/**
 * Resolve a directory into its placement — the ONE owner of the rule ({@link findPlacement}): `dir` is
 * the workspace, and the agent is the single `fastagent.config.*` holder at it or one level inside.
 * Placement is never configured and never detected from surroundings; it is that lookup and the
 * directory you pointed at.
 *
 * Anything else throws (fail visibly). Resolution never walks UP — an agent must not be claimed from
 * arbitrarily deep inside it — but the MESSAGE reads the path, so each dead end gets the exit that fits
 * it ({@link placementDeadEnd}).
 */
export function resolvePlacement(dir: string, env: NodeJS.ProcessEnv = process.env): ResolvedPlacement {
  const placement = findPlacement(dir, env);
  if (!placement) {
    const base = resolve(dir);
    throw new Error(
      placementDeadEnd(base, env) ??
        `${base} is not a fastagent agent — no fastagent.config.* here, and no directory holding one ` +
          `directly inside; run \`fastagent init\` to scaffold one`,
    );
  }
  return placement;
}

/** How to WRITE a path for someone standing in `cwd`: relative when it is inside `cwd`, absolute when
 *  it climbs out (a `../../..` is noise), and undefined when it IS `cwd` (nothing to say). ONE policy,
 *  shared by `init`'s `cd` step, `add`'s next-steps paths and `fire`'s "looked in" hint — they all answer
 *  the same question, which is a placement-PRESENTATION question, not a scaffolding one. */
export function displayPath(cwd: string, dir: string): string | undefined {
  const rel = relative(cwd, dir);
  if (rel === "") return undefined;
  // "Climbs out" is a path-SEGMENT check — rel is ".." or starts with "../" (or "..\" on Windows). A
  // bare startsWith("..") would wrongly flag an in-cwd directory literally named "..agent".
  const escapes = rel === ".." || /^\.\.[/\\]/.test(rel);
  return escapes ? dir : rel;
}

/** Does a path exist? Plain fs, no placement in it — it lives here because `paths.ts` is where the
 *  neutral path helpers are, and the scaffolder is not a utility home for the CLI and deploy. */
export async function exists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}

/** The file's text, or undefined when there is no file. ONLY absence reads as absence: a file that
 *  exists but cannot be read (EACCES, a directory in its place) throws, because a decision made on
 *  "not there" — regenerate it, skip its gate — is the wrong one for a file that is there. */
export async function readTextIfExists(p: string): Promise<string | undefined> {
  try {
    return await readFile(p, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Resolve a user-supplied path override (a CLI flag or an env var) to an absolute path, expanding a
 * leading `~`/`~/` to the home dir FIRST. Path-valued config from `.env` (or any non-shell source)
 * never gets the shell's `~` expansion, so a bare `resolve("~/x")` would silently create a literal `~`
 * directory — a fail-silently footgun for a secret/state path. Expanding here makes `~` mean home
 * everywhere these knobs are read.
 */
export function resolveOverridePath(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const expanded = raw === "~" ? homedir() : raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
  return resolve(expanded);
}

/**
 * The resolved state root — the durable machine-state home (sessions/, channels/<kind>/, schedule/,
 * control.json): `FASTAGENT_STATE_DIR` env > `<agentDir>/.state`. Absolute, so channels and the
 * startup report agree regardless of cwd. Definition: mutable runtime state — single lifecycle
 * (precious, survives redeploy), single process; a container points this at its mounted volume.
 * Secrets are NOT here — they live under {@link resolveSecretsDir} (a different deploy lifecycle:
 * secret store vs volume). The finer knob (`FASTAGENT_SESSIONS_DIR`) still overrides its path on top.
 *
 * `FASTAGENT_STATE_DIR` is an OPERATOR override, so a relative value resolves against `process.cwd()`
 * — the CLI convention its sibling knobs share (`resolveOverridePath`), NOT against `dir`. Only the
 * DEFAULT (`<root>/.state`) is dir-anchored.
 */
export function resolveStateRoot(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolveOverridePath(env.FASTAGENT_STATE_DIR) ?? join(resolve(dir), STATE_DIRNAME);
}

/**
 * The resolved secrets dir — everything fastagent manages that must NEVER leave the machine (the
 * agent's `.env` + auth.json): `FASTAGENT_SECRETS_DIR` env > `<agentDir>/.secrets`. Split from
 * the state root on deploy lifecycle: secrets travel through the host's secret store (env vars / the
 * auth seed), state through a volume. A deployed box sets both env knobs at its volume (e.g.
 * `/data/.secrets`, `/data/.state`) so a seeded-then-ROTATED OAuth credential persists across
 * restarts. The `.env`'s OWN location resolves from the REAL environment — commands locate and load
 * `.env` before anything else, so a `FASTAGENT_SECRETS_DIR` set INSIDE `.env` still relocates
 * auth.json but cannot move the file it is read from (env.ts dotEnvPath).
 */
export function resolveSecretsDir(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolveOverridePath(env.FASTAGENT_SECRETS_DIR) ?? join(resolve(dir), SECRETS_DIRNAME);
}

/** What a file under {@link resolveSecretsDir} is written with (auth.json, .env). */
export const SECRET_FILE_MODE = 0o600;
/** What the secrets directory itself is created with. */
const SECRETS_DIR_MODE = 0o700;

/**
 * Create the secrets directory with the mode its contents require — and REPAIR it when it already
 * exists, which is the case that matters.
 *
 * The DIRECTORY is the boundary that actually protects a credential: without its `x` bit nothing
 * below it is reachable, whatever a file's own mode says. And it is decided ONCE, by whichever
 * writer gets there first — `mkdir`'s `mode` is ignored for a directory that already exists, so a
 * later, more careful caller silently inherits the first one's answer. Four callers create this
 * directory (`init`, `add <channel>`, the credential store, the deploy seed) and the ordinary order
 * is init → add → login, so the careful one is LAST: the rule has to live where all of them can
 * reach it, and it has to chmod rather than trust the create.
 *
 * A chmod the caller never asked for owes them its reason: the raw `EPERM ... chmod '/shared/creds'`
 * reads as a bug in whatever they WERE doing (storing a credential), not as fastagent tightening a
 * directory they pointed it at, and says nothing about the way out.
 */
export async function ensureSecretsDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: SECRETS_DIR_MODE });
  await chmod(dir, SECRETS_DIR_MODE).catch((e: Error) => {
    throw new Error(
      `cannot secure secrets dir ${dir} (fastagent keeps it 0700): ${e.message} — point --auth-path/FASTAGENT_SECRETS_DIR at a directory this process owns`,
      { cause: e },
    );
  });
}

/**
 * Guard that `<agentDir>/<name>` resolves INSIDE the agent dir — a symlink that escapes (or an
 * absolute target) is rejected, so discovery/scaffolding never reaches out of the definition directory.
 * A missing target is fine (nothing to guard yet).
 */
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

/**
 * Whether `targetPath` lives inside `baseDir` (same path counts). Used to ask "did an override move
 * this OUT of the agent?" — the startup report's redeploy notes, `add`'s printed `.env` label, and the
 * dev watcher's "your .env is not watched" warning all turn on that fact. Reporting only: fastagent
 * does not act on where a user's paths point.
 */
export function isUnderDir(targetPath: string, baseDir: string): boolean {
  const rel = relative(baseDir, targetPath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
