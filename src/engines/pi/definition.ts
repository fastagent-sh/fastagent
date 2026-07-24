/**
 * Definition domain: read an agent definition directory (AGENTS.md + skills/) into memory. Produces
 * data; create.ts consumes it.
 *
 * IO policy: persona.md + skills load through ExecutionEnv (portable across local/sandbox/remote); the
 * invoke path never touches disk. EXCEPTION — ② project context comes from pi's loadProjectContextFiles,
 * which reads via node fs DIRECTLY (not the injected `env`) and, on failure, at best warns to stderr and
 * at worst is fully silent (its `existsSync` probe swallows a permission error) — no structured signal. So under a
 * non-local ExecutionEnv the ② files still resolve against THIS process's filesystem, not the target env
 * — a known break in the portability contract, deferred with the sandbox work (core.md §6). config/auth/
 * sessions and this module's Node helpers are composition-root code and may use node fs.
 *
 * Errors: a broken persona.md / unresolvable dir throws (fail loudly at startup); non-fatal findings
 * (bad skill files, name collisions) are returned as data. An unreadable ② context file only warns (pi).
 */
import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import ignore from "ignore";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ExecutionEnv, Skill, SkillDiagnostic } from "@earendil-works/pi-agent-core";
import { loadSkills } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { loadProjectContextFiles } from "@earendil-works/pi-coding-agent";

/** A same-name skill collision (the discarded side). Surfaced, never swallowed. */
export interface SkillCollision {
  name: string;
  winnerPath: string;
  loserPath: string;
}

/** Result of loading a definition directory. Produced by {@link loadAgentDefinition}. */
export interface LoadedDefinition {
  /**
   * Project-context files feeding segment ② `<project_context>`, sourced via pi's `loadProjectContextFiles`:
   * the agentDir's own AGENTS.md/CLAUDE.md FIRST, then every AGENTS.md from root down to `cwd` (so the
   * file nearest `cwd` comes LAST — pi's array order). Empty when none exist. This WALKS cwd's ancestors (pi's coding-agent behaviour) — see core.md §6.
   */
  contextFiles: Array<{ path: string; content: string }>;
  /**
   * Verbatim `persona.md` content — the authored persona that OVERRIDES segment ①'s identity line
   * (piBasePrompt keeps the tool list + guidelines; NOT a full system-prompt replacement — that is L1
   * createPiAgent's `instructions`). undefined when absent → segment ① is the default engine identity.
   */
  persona?: string;
  skills: Skill[];
  /** Non-fatal per-file skill problems reported by pi's loader. */
  diagnostics: SkillDiagnostic[];
  /** Same-name conflicts across mounts (first-wins). */
  collisions: SkillCollision[];
  /** Absolute agent-definition directory path (persona.md/skills/ live here). */
  dir: string;
}

export interface LoadAgentDefinitionOptions {
  /**
   * Working directory whose ancestors are walked for context files (segment ②). Default = `agentDir`
   * (flat: the agent dir is also the run root). The opener passes the run root so a coding agent that
   * lives in `agentDir` picks up the host repo's AGENTS.md up the tree (core.md scenario grid).
   */
  cwd?: string;
  env?: ExecutionEnv;
}

/** Read an agent definition. persona.md/skills come from `agentDir`; ② context = pi's loadProjectContextFiles({ cwd, agentDir }). */
export async function loadAgentDefinition(
  agentDir: string,
  options: LoadAgentDefinitionOptions = {},
): Promise<LoadedDefinition> {
  // One resolved default for the working directory (env cwd AND the context-walk start), so they can
  // never diverge if a caller passes a relative agentDir.
  const cwd = options.cwd ?? agentDir;
  const e = options.env ?? new NodeExecutionEnv({ cwd });
  const rootResult = await e.absolutePath(agentDir);
  if (!rootResult.ok) {
    throw new Error(`cannot resolve agent dir "${agentDir}": ${rootResult.error.message}`);
  }
  const root = rootResult.value;

  // ② project context, following pi: the agentDir's own AGENTS.md + every AGENTS.md walking cwd up to
  // root (loadProjectContextFiles). It reads via node fs directly (mirrors pi), NOT the ExecutionEnv —
  // a deliberate, deferred deviation from this module's portable-IO policy (revisit with the sandbox; core.md §6).
  const contextFiles = loadProjectContextFiles({ cwd, agentDir: root });

  // persona.md → segment ① persona (overrides the identity line). Same error policy as AGENTS.md:
  // only not_found means "absent"; any other read error surfaces rather than silently dropping the persona.
  const personaPath = join(root, "persona.md");
  const personaRead = await e.readTextFile(personaPath);
  if (!personaRead.ok && personaRead.error.code !== "not_found") {
    throw new Error(`cannot read ${personaPath}: ${personaRead.error.message}`);
  }
  const persona = personaRead.ok ? personaRead.value : undefined;

  // Skills come ONLY from the definition's own skills/ (no external/global mount), so the same
  // definition loads the same skills on every machine.
  const { skills: raw, diagnostics } = await loadSkills(e, [join(root, "skills")]);
  const byName = new Map<string, Skill>();
  const collisions: SkillCollision[] = [];
  for (const skill of raw) {
    const existing = byName.get(skill.name);
    if (existing) {
      collisions.push({ name: skill.name, winnerPath: existing.filePath, loserPath: skill.filePath });
    } else {
      byName.set(skill.name, skill);
    }
  }

  return { contextFiles, persona, skills: [...byName.values()], diagnostics, collisions, dir: root };
}

/**
 * Whether `targetPath` lives inside `baseDir` (same path counts). The self-ignore guard uses it to ask
 * "does the resolved state root land inside the workspace tree?" — an in-tree root (the default
 * `.fastagent`, or a custom `FASTAGENT_STATE_DIR` pointed inside the agent dir) is ours to self-ignore;
 * a root on an external volume resolves outside and must not be (we never write a `.gitignore` outside
 * the tree). Whether a relative override lands in-tree is a cwd question — see `resolveStateRoot`.
 */
export function isUnderDir(targetPath: string, baseDir: string): boolean {
  const rel = relative(baseDir, targetPath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Self-ignore a machinery dir: create it if missing, then write `<dir>/.gitignore` = `content`, so a
 * workspace that runs dev/start/login never shows machine state or secrets as
 * untracked-but-committable. Creates the dir because a caller may self-ignore it before anything else
 * populates it (e.g. `login` writing auth.json into a not-yet-created dir).
 *
 * An EXISTING `.gitignore` is kept — but only after VERIFYING it still does the one job this guard
 * exists for: every name in `mustIgnore` must actually be ignored by its rules. "A file exists" is
 * not "the contents are protected" — an emptied file, a bad merge, or a `!.env` re-include would
 * otherwise pass silently and the next `login`/`add` would write a real credential into a COMMITTABLE
 * dir. A failing file throws with the remedy (fail visibly; the caller was about to write a secret).
 *
 * Module-PRIVATE on purpose: the only entries to the leak guard are {@link ensureStateRootSelfIgnored}
 * and {@link ensureSecretsDirSelfIgnored} (home exclusion + containment). Keeping this unexported makes
 * that single-owner claim hold at the type level — a sibling command can't bypass those checks by
 * writing a `.gitignore` directly.
 */
async function ensureDirSelfIgnored(dir: string, content: string, mustIgnore: string[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(join(dir, ".gitignore"), content, { flag: "wx" }); // wx: never clobber
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const file = join(dir, ".gitignore");
  // Same matcher discipline as loadRootIgnore (workspace.ts): case-sensitive, git semantics — a
  // later `!name` line un-ignores exactly like git would, so the check can't disagree with git.
  const matcher = ignore({ ignorecase: false }).add(await readFile(file, "utf8"));
  const leaks = mustIgnore.filter((name) => !matcher.ignores(name));
  if (leaks.length > 0) {
    const rules = content.trim().split("\n").join(" + ");
    throw new Error(
      `${file} does not ignore ${leaks.join(", ")} — this fastagent-managed dir must keep its contents ` +
        `out of git before a secret/state file is written. Restore the self-ignore rules (${rules}), or ` +
        `delete the file and fastagent rewrites it`,
    );
  }
}

/** The `.secrets/` self-ignore: everything is a secret EXCEPT the committable template and the
 *  protection itself (un-ignored so both travel with the workspace through git; git's nested-ignore
 *  precedence means no root .gitignore entry can re-include the rest). The scaffold's
 *  templates/secrets.gitignore mirrors these rules. */
const SECRETS_GITIGNORE = "*\n!.gitignore\n!.env.example\n";

/**
 * The single owner of the self-ignore MECHANISM: iff the resolved state ROOT lands inside the workspace
 * tree, write `<stateRoot>/.gitignore="*"` — which then covers EVERYTHING under it (sessions, auth.json,
 * every channel's `channels/<kind>` home). `ensureStateDirSelfIgnored` is private, so a caller cannot
 * write a `.gitignore` bypassing this.
 *
 * ROOT-based, not path-based: everything derives from the state root (config.ts), so protecting the
 * root protects all of it — INCLUDING a custom in-tree root (a `FASTAGENT_STATE_DIR` inside the agent
 * dir), the case a path-based (`.fastagent`-only) guard would leak. A per-path override
 * (`--sessions-dir`/`--auth-path`) is operator-owned: pointed at an external volume it is out-of-tree
 * (correctly not ours to ignore); pointed at a custom in-tree dir WE DON'T OWN, we do not write a
 * `.gitignore` into it (it may be a directory the operator deliberately tracks).
 *
 * Excludes the user's HOME-global `~/.fastagent` (e.g. `login`/`dev` run from `$HOME`): self-ignore is
 * for protecting state inside an agent PROJECT tree, not for writing a `.gitignore` into the user's
 * home, which a dotfiles repo may track. The global credential file there was never self-ignored.
 */
export async function ensureStateRootSelfIgnored(dir: string, stateRoot: string): Promise<void> {
  // Compare CANONICAL paths for the home check: `dir` arrives realpath-resolved (it is `process.cwd()`
  // or `resolve(".")`) but `homedir()` returns the raw `$HOME`, so a symlinked home would slip past raw
  // equality and we'd write a `.gitignore` into the real `~/.fastagent` — the very thing the doc forbids
  // (chat.ts canonicalizes for the same reason).
  if (canonicalPath(dir) === canonicalPath(homedir())) return;
  // Containment on RAW paths: stateRoot is resolve()'d (config.ts) and `dir` is absolute, so it is exact
  // by construction. An external-volume root resolves outside the tree → skip (not ours to ignore).
  // Must-ignore names = the state dirs that actually live here (representative, not exhaustive).
  if (isUnderDir(stateRoot, dir)) await ensureDirSelfIgnored(stateRoot, "*\n", ["sessions", "channels", "schedule"]);
}

/**
 * The `.secrets/` sibling of {@link ensureStateRootSelfIgnored}: iff the resolved secrets dir lands
 * inside the workspace tree, make it exist and self-ignore ({@link SECRETS_GITIGNORE}) — called by
 * every path that WRITES a secret (`login`, the opener, channel onboarding), so a credential or `.env`
 * value can never land untracked-but-committable. Same home exclusion and containment rules.
 */
export async function ensureSecretsDirSelfIgnored(dir: string, secretsDir: string): Promise<void> {
  if (canonicalPath(dir) === canonicalPath(homedir())) return;
  if (isUnderDir(secretsDir, dir)) await ensureDirSelfIgnored(secretsDir, SECRETS_GITIGNORE, [".env", "auth.json"]);
}

/** Resolve to a canonical (symlink-free) absolute path so comparisons match `process.cwd()`'s realpath.
 *  A non-existent path can't be realpath'd, so it stays as the plain absolute resolve. */
export function canonicalPath(p: string): string {
  const resolved = resolve(p);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}
