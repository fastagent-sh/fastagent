/**
 * Definition domain: read an agent definition folder (AGENTS.md + skills/) into
 * memory, and materialize it into a deployable artifact. No dependency on agent
 * creation — this module produces data; create.ts consumes it.
 *
 * Domain note: the definition CONCEPT is engine-neutral (AGENTS.md / agentskills
 * are cross-product standards — the definition is input to a harness, never part
 * of it). This IMPLEMENTATION is pi-folded (pi's loadSkills / Skill types) per the
 * folded-M decision; lift it out of engines/pi when engine #2 lands.
 *
 * IO policy (the precise form of the "core does not read disk" invariant):
 *   - the runtime load path (loadAgentDefinition) does IO **only through ExecutionEnv**
 *     (portable: local / sandbox / remote envs);
 *   - bundleAgentDefinition is a **build-time** operation and uses node:fs directly
 *     (it runs on the build machine by definition);
 *   - the invoke path (invoke.ts/harness.ts) never touches the disk itself;
 *   - config.ts / auth.ts / sessions.ts (and create.ts's L3 workspace-state setup)
 *     are Node composition-root code and may use node fs.
 *
 * Error conventions on this path:
 *   - ExecutionEnv layer returns Result (pi's contract);
 *   - this module converts Results to **throws** (a broken definition should fail
 *     loudly at startup, not at first invoke);
 *   - non-fatal load findings (bad skill files, name collisions) are returned as
 *     data (diagnostics/collisions) for the caller to surface — visible, not fatal.
 */
import { copyFile, mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import ignore, { type Ignore } from "ignore";
import type { ExecutionEnv, Skill, SkillDiagnostic } from "@earendil-works/pi-agent-core";
import { loadSkills } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

/** A same-name skill collision (the discarded side). Must surface, never swallowed (fail visibly). */
export interface SkillCollision {
  name: string;
  winnerPath: string;
  loserPath: string;
}

/**
 * Result of loading a definition folder. Produced by {@link loadAgentDefinition};
 * never hand-authored — the authored definition is the folder itself.
 */
export interface LoadedDefinition {
  /** Verbatim AGENTS.md content (feeds prompt segment ②); undefined when the file does not exist. */
  instructions?: string;
  skills: Skill[];
  /** Non-fatal per-file skill problems reported by pi's loader (skill skipped, reason recorded). */
  diagnostics: SkillDiagnostic[];
  /** Same-name conflicts across mounts (first-wins; definition-local wins). */
  collisions: SkillCollision[];
  /** Absolute definition folder path. AGENTS.md, when present, is at join(dir, "AGENTS.md"). */
  dir: string;
}

/**
 * The machine's global skills directories (pi user-level + the cross-tool standard
 * directory). This is an explicit OPT-IN helper, not a default: loading is
 * definition-only unless a caller passes these in (e.g. `fastagent dev
 * --global-skills` for local-authoring fidelity, or `fastagent build
 * --global-skills` to materialize them into the artifact). Keeping it out of the
 * default makes "your folder is the agent" structural — the same definition loads
 * the same skills on every machine, and dev behavior equals deployed behavior.
 */
export function defaultGlobalSkillPaths(): string[] {
  return [join(homedir(), ".pi", "agent", "skills"), join(homedir(), ".agents", "skills")];
}

export interface LoadAgentDefinitionOptions {
  env?: ExecutionEnv;
  /**
   * Extra skills mount directories, appended after the definition-local `skills/`.
   * **Default = [] (definition-only)**: the agent is exactly its folder, so the same
   * definition is reproducible across machines and dev mirrors deployment. Missing
   * directories are skipped. Opt in explicitly:
   *   - `defaultGlobalSkillPaths()` → load the machine's global skills (local-pi
   *     fidelity during authoring; not portable, so dev/build must pass it on purpose);
   *   - custom array → precise control over what is mounted;
   *   - to ship globals, materialize them into the artifact via bundleAgentDefinition.
   * Collisions: definition-local skills win (the deployable unit is authoritative);
   * first-wins + surfaced collision.
   */
  skillPaths?: string[];
}

/** Read a definition folder. env defaults to local Node (cwd=dir); non-local deployments inject their env. */
export async function loadAgentDefinition(
  dir: string,
  options: LoadAgentDefinitionOptions = {},
): Promise<LoadedDefinition> {
  const e = options.env ?? new NodeExecutionEnv({ cwd: dir });
  const rootResult = await e.absolutePath(dir);
  if (!rootResult.ok) {
    // No silent fallback: a failing absolutePath means the env itself is broken.
    throw new Error(`cannot resolve definition dir "${dir}": ${rootResult.error.message}`);
  }
  const root = rootResult.value;

  const agentsPath = join(root, "AGENTS.md");
  const read = await e.readTextFile(agentsPath);
  // Only not_found means "no AGENTS.md". Anything else (permission, io) must surface,
  // otherwise the agent silently runs without instructions (AGENTS.md rule 8).
  if (!read.ok && read.error.code !== "not_found") {
    throw new Error(`cannot read ${agentsPath}: ${read.error.message}`);
  }
  const instructions = read.ok ? read.value : undefined;

  // Definition-local skills first → definition wins collisions (first-wins).
  // Default is definition-only ([]): "your folder is the agent". Global/extra
  // mounts are an explicit opt-in (see skillPaths / defaultGlobalSkillPaths).
  const { skills: raw, diagnostics } = await loadSkills(e, [
    join(root, "skills"),
    ...(options.skillPaths ?? []),
  ]);
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

  return {
    instructions,
    skills: [...byName.values()],
    diagnostics,
    collisions,
    dir: root,
  };
}

/**
 * Names never meaningful to ship, excluded unconditionally at any depth: VCS metadata,
 * dependencies (reinstalled at deploy via `npm ci`), and fastagent machine state (runtime
 * sessions + the build output). This is NOT a security list — secrets like `.env` are not
 * special-cased; the user manages those via .gitignore (git mode) or `.fastagentignore`
 * (security is the user's responsibility, by design).
 */
function isHardExcluded(name: string): boolean {
  return name === ".git" || name === "node_modules" || name === ".fastagent";
}

/**
 * Read a directory's ignore files (`.gitignore` then `.fastagentignore`, combined into one
 * matchers) or `{}` if neither exists. The two are kept SEPARATE (not merged) because
 * `.fastagentignore` is authoritative over `.gitignore` (see scopedIgnored): a nested
 * `.gitignore` re-inclusion must not override a build-specific `.fastagentignore` exclude.
 * We honor `.gitignore` ourselves (via the `ignore` library, a faithful matcher) rather
 * than calling git, so the artifact is reproducible (independent of the build machine's
 * git install / global excludes / index) — the whole point of a portable bundle.
 *
 * An existing-but-unreadable file fails visibly — silently building with no rules could
 * ship files the author meant to exclude.
 */
async function loadDirIgnore(dir: string): Promise<{ git?: Ignore; fa?: Ignore }> {
  const read = async (name: string): Promise<Ignore | undefined> => {
    try {
      return ignore().add(await readFile(join(dir, name), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(`cannot read ${join(dir, name)}: ${(error as Error).message}`);
    }
  };
  return { git: await read(".gitignore"), fa: await read(".fastagentignore") };
}

/** A directory's ignore matchers, keyed by the matcher's ABSOLUTE directory, so each
 *  pattern is tested relative to THAT directory — which lets ancestor ignore files (above
 *  the build root, e.g. a monorepo-root .gitignore) anchor correctly too. */
interface ScopedIgnore {
  baseAbs: string;
  git?: Ignore;
  fa?: Ignore;
}

/** The verdict of one kind of ignore file across the ancestor stack: composed root → deep
 *  so a DEEPER file overrides a shallower one (git's last-match-wins; `ignore.test()` tells
 *  an explicit un-ignore from a non-match). undefined = no rule had an opinion. */
function stackVerdict(stack: ScopedIgnore[], pick: (s: ScopedIgnore) => Ignore | undefined, entryAbs: string, isDir: boolean): boolean | undefined {
  let v: boolean | undefined;
  for (const s of stack) {
    const ig = pick(s);
    if (!ig) continue;
    const sub = toPosix(relative(s.baseAbs, entryAbs)); // entry path relative to the matcher's dir
    // Outside the matcher iff empty or an UP traversal (".." / "../…"). A separator-aware
    // check, so a real filename like "..secret.env" (a forward path) is still matched.
    if (sub === "" || sub === ".." || sub.startsWith("../")) continue;
    const verdict = ig.test(isDir ? `${sub}/` : sub); // dir patterns match only with a trailing slash
    if (verdict.ignored) v = true;
    else if (verdict.unignored) v = false; // explicit negation re-includes
  }
  return v;
}

/**
 * Whether an entry is excluded by the ignore files from the root down to it. `.gitignore`
 * and `.fastagentignore` are evaluated as SEPARATE hierarchies (each with full nested
 * last-match-wins semantics), then combined with `.fastagentignore` AUTHORITATIVE: if it
 * has a verdict (exclude, or an explicit `!` re-include) that wins; only when it is silent
 * does `.gitignore` decide. So a nested `.gitignore` `!` can never override a
 * `.fastagentignore` exclude — `.fastagentignore` is the git-independent guarantee.
 * (A file under an already-excluded DIRECTORY is never reached — the walk does not descend
 * into ignored dirs — so git's "can't re-include below an excluded dir" holds for free.)
 */
function scopedIgnored(stack: ScopedIgnore[], entryAbs: string, isDir: boolean): boolean {
  const fa = stackVerdict(stack, (s) => s.fa, entryAbs, isDir);
  if (fa !== undefined) return fa;
  return stackVerdict(stack, (s) => s.git, entryAbs, isDir) ?? false;
}

/** The nearest ancestor of `start` (inclusive) that contains a `.git` entry — the repo
 *  root — or undefined when none up to the filesystem root. A bounded stat walk (no git),
 *  used only to limit how far UP ancestor ignore files are honored. */
async function findRepoRoot(start: string): Promise<string | undefined> {
  let d = resolve(start);
  for (;;) {
    if (await stat(join(d, ".git")).then(() => true, () => false)) return d;
    const parent = dirname(d);
    if (parent === d) return undefined; // reached the filesystem root, no repo
    d = parent;
  }
}

/** Normalize a relative path to POSIX separators for ignore lookups (Windows). */
function toPosix(rel: string): string {
  return sep === "/" ? rel : rel.split(sep).join("/");
}

/** The exact artifact contents of a source tree: regular files (artifact-relative POSIX
 * paths) to copy, plus the dirs to create (so empty allowed dirs survive). */
interface ShipPlan {
  files: { abs: string; rel: string }[];
  dirs: string[];
}

/**
 * Compute the SINGLE source of truth for what a source tree contributes to an artifact:
 * one filesystem walk that applies every exclusion and returns the exact ship-set. Both
 * the "definition files must ship" validation and the copy use this one plan, so they can
 * never disagree (which is why a parallel ship predicate is gone).
 *
 * Exclusions: the hard set (deps/vcs/state, by name at any depth) always; and the nested
 * `.gitignore` + `.fastagentignore` rules read along the way (`ScopedIgnore` stack), each
 * pattern tested relative to its own directory. We do NOT call git — honoring `.gitignore`
 * ourselves makes the artifact reproducible (independent of the build machine's git).
 * `skipReal` (a realpath) is excluded so an in-tree out dir is not walked.
 *
 * Symlinks are dereferenced (follow `stat`): a link to a directory is recursed into (its
 * own nested ignore files apply uniformly), a link to a file is copied, a dangling link is
 * skipped. A submodule needs no special case — it is just a directory with its own nested
 * `.gitignore`. Cycles (e.g. `link -> .`) are broken by tracking the recursion STACK of
 * target realpaths.
 */
async function planShipSet(srcDir: string, opts: { skip?: string[] } = {}): Promise<ShipPlan> {
  const skip = opts.skip ?? [];
  // realpath the root so repo-root discovery + ancestor-ignore anchoring follow the REAL
  // path: a workspace reached through a symlink still finds the actual monorepo's .git and
  // its parent .gitignore files. Artifact paths are relative, so forward names are unchanged.
  const topBase = await realpath(srcDir).catch(() => resolve(srcDir));
  const files: { abs: string; rel: string }[] = [];
  const dirs: string[] = [];
  const ignoreStack: ScopedIgnore[] = []; // ancestor dirs' ignore matchers, root → current

  async function walk(absDir: string, stack: Set<string>): Promise<void> {
    const realDir = await realpath(absDir).catch(() => resolve(absDir));
    // Skip the build's own dirs by REALPATH (staging + the final publish target), so they
    // are recognized through symlink aliases and never walked into the artifact.
    if (skip.some((s) => realDir === s || realDir.startsWith(s + sep))) return;
    if (stack.has(realDir)) return; // cycle: realDir is its own ancestor on this descent
    stack.add(realDir);
    const relDir = toPosix(relative(topBase, absDir));
    if (relDir !== "") dirs.push(relDir); // record dirs so empty (but included) ones survive
    const { git, fa } = await loadDirIgnore(absDir); // this dir's ignore files govern its subtree
    const pushed = git !== undefined || fa !== undefined;
    if (pushed) ignoreStack.push({ baseAbs: absDir, git, fa });
    for (const entry of await readdir(absDir, { withFileTypes: true })) {
      const abs = join(absDir, entry.name);
      if (isHardExcluded(entry.name)) continue;
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      const isLink = entry.isSymbolicLink();
      if (isLink) {
        const target = await stat(abs).catch(() => undefined); // follow the link
        if (!target) continue; // dangling → skip rather than fail the build
        isDir = target.isDirectory();
        isFile = target.isFile();
      }
      // Only directories and regular files belong in an artifact. Skip sockets, FIFOs,
      // and devices — copyFile would throw on them and fail the whole build.
      if (!isDir && !isFile) continue;
      const rel = toPosix(relative(topBase, abs));
      if (scopedIgnored(ignoreStack, abs, isDir)) continue;
      if (isDir) await walk(abs, stack);
      else files.push({ abs, rel }); // regular file (follows a symlink-to-file)
    }
    if (pushed) ignoreStack.pop();
    stack.delete(realDir); // leave the descent: siblings sharing this target are not a cycle
  }

  // Seed ANCESTOR ignore files up to the repo root, so a monorepo-root .gitignore applies to
  // a package build (`fastagent build packages/agent`). Bounded at the repo root (.git):
  // above it is not part of the project, and stopping there keeps the artifact reproducible.
  // These stay on the stack for the whole walk (root → deep, so deeper files still override).
  const repoRoot = await findRepoRoot(topBase);
  if (repoRoot !== undefined && repoRoot !== topBase) {
    const chain: string[] = [];
    for (let d = dirname(topBase); ; d = dirname(d)) {
      chain.push(d);
      if (d === repoRoot || dirname(d) === d) break;
    }
    for (const dir of chain.reverse()) {
      const { git, fa } = await loadDirIgnore(dir);
      if (git !== undefined || fa !== undefined) ignoreStack.push({ baseAbs: dir, git, fa });
    }
  }
  await walk(topBase, new Set());
  return { files, dirs };
}

/** Materialize a {@link ShipPlan} into outDir: create allowed dirs, then copy each file. */
async function executeShipPlan(plan: ShipPlan, outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true });
  for (const rel of plan.dirs) await mkdir(join(outDir, rel), { recursive: true });
  for (const f of plan.files) await copyFile(f.abs, join(outDir, f.rel));
}

/**
 * Bundle (the "compile" stage): materialize a self-contained, relocatable artifact — the
 * deployable agent (core-design §10.1/§10.3).
 *
 * TWO independent productions, so the artifact == the reported agent BY CONSTRUCTION (no
 * "copy the tree then patch it to match the model"):
 *   - the AUTHORED CONTEXT tree (AGENTS.md, docs/, fastagent.config.ts, tool source,
 *     package.json, …) is copied via the ignore-aware walk, EXCLUDING skills/;
 *   - outDir/skills/ is produced from the RESOLVED skill model: each WINNING skill
 *     (definition.skills — local AND mounted, treated uniformly) is materialized to
 *     skills/<name> via the same walk (its own + ancestor .gitignore honored). Names are
 *     unique after dedup, so destinations never collide; collision losers and non-loaded
 *     skills simply never appear.
 *
 * Hard-excluded everywhere: node_modules, .git, .fastagent (isHardExcluded). Secrets are
 * NOT special-cased; the user excludes them via .gitignore/.fastagentignore.
 *
 * Fills outDir, which the caller OWNS and guarantees fresh (buildPiArtifact stages then
 * publishes atomically); bundle is non-destructive and needs no overwrite/aliasing guard.
 * The walk skips the build's own dirs (caller skipPaths) so output is never bundled into
 * itself.
 */
export async function bundleAgentDefinition(
  srcDir: string,
  outDir: string,
  options: LoadAgentDefinitionOptions = {},
  bundleOpts: { reservedRootFile?: string; skipPaths?: string[] } = {},
): Promise<LoadedDefinition> {
  const definition = await loadAgentDefinition(srcDir, options);
  const srcReal = await realpath(srcDir).catch(() => resolve(srcDir));
  const skillsDir = join(srcReal, "skills"); // produced from the model, NOT copied from the tree

  // Production 1 — the authored context tree, EXCLUDING skills/. Skip the build's own dirs
  // (staging / final target) too, so output is never bundled into itself.
  const skipHere = await realpath(outDir).catch(() => resolve(outDir));
  const skipExtra = await Promise.all(
    (bundleOpts.skipPaths ?? []).map((p) => realpath(p).catch(() => resolve(p))),
  );
  const plan = await planShipSet(srcDir, { skip: [skipHere, ...skipExtra, skillsDir] });
  const shipped = new Set(plan.files.map((f) => f.rel));
  const shippedDirs = new Set(plan.dirs);

  // A caller-reserved root name (the build manifest, fastagent.json) only collides if it
  // would actually SHIP (an ignored one is not in the plan). Match a shipped FILE or DIR —
  // a root dir by that name would otherwise make the later manifest write fail with EISDIR.
  const reserved = bundleOpts.reservedRootFile;
  if (reserved !== undefined && (shipped.has(reserved) || shippedDirs.has(reserved))) {
    throw new Error(
      `"${reserved}" is reserved for the build manifest; the source ships an entry by that name ` +
        `at the artifact root — rename it or exclude it (config goes in fastagent.config.ts/js/mjs)`,
    );
  }

  // AGENTS.md ships at its tree path; if an ignore rule dropped it the artifact would not
  // match the reported agent.
  if (definition.instructions !== undefined && !shipped.has("AGENTS.md")) {
    throw new Error(
      `AGENTS.md is excluded from the artifact by an ignore rule; un-ignore it (git / .fastagentignore) — it must ship.`,
    );
  }
  await executeShipPlan(plan, outDir);

  // Production 2 — outDir/skills/ from the resolved model. Each winning skill (local or
  // mounted, uniformly) goes to skills/<name>; the same ignore-aware walk excludes its
  // internal junk, and its defining SKILL.md must survive or the build fails visibly.
  await mkdir(join(outDir, "skills"), { recursive: true });
  for (const skill of definition.skills) {
    if (basename(skill.filePath) === "SKILL.md") {
      const skillPlan = await planShipSet(dirname(skill.filePath));
      if (!skillPlan.files.some((f) => f.rel === "SKILL.md")) {
        throw new Error(
          `skill "${skill.name}" (${skill.filePath}) has its SKILL.md excluded by an ignore rule; ` +
            `un-ignore it — it must ship.`,
        );
      }
      await executeShipPlan(skillPlan, join(outDir, "skills", skill.name));
    } else {
      // a single-file skill (the file IS the skill): copy it by name — unique, deterministic
      await copyFile(skill.filePath, join(outDir, "skills", `${skill.name}.md`));
    }
  }
  return definition;
}
