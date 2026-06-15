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
import { copyFile, mkdir, readFile, readdir, realpath } from "node:fs/promises";
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
 * Load the build root's exclude rules into ONE flat matcher: `.gitignore` then
 * `.fastagentignore` (fa last → authoritative on conflicts), applied artifact-relative to
 * the whole tree. Deliberately FLAT — we read only the ROOT files, not nested .gitignore
 * down the tree and not ancestor .gitignore up a monorepo. Reproducing git's full nested +
 * ancestor + repo-boundary ignore engine by hand is an open-ended edge factory (it was);
 * the contract is simply "hard excludes + your root .gitignore/.fastagentignore". For
 * finer or monorepo-package control, put rules in the root `.fastagentignore`. The single
 * `ignore` library matcher handles git's PER-FILE pattern syntax (negation, anchoring,
 * `**`, dir-slash) faithfully — that part is not hand-rolled.
 *
 * An existing-but-unreadable file fails visibly — silently building with no rules could
 * ship files the author meant to exclude.
 */
async function loadRootIgnore(dir: string): Promise<Ignore | undefined> {
  let rules = "";
  for (const name of [".gitignore", ".fastagentignore"]) {
    try {
      rules += `\n${await readFile(join(dir, name), "utf8")}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`cannot read ${join(dir, name)}: ${(error as Error).message}`);
      }
    }
  }
  return rules.trim() === "" ? undefined : ignore().add(rules);
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
 * Compute exactly what a source tree contributes to the artifact: one filesystem walk
 * returning the regular files (+ dirs to create) to copy.
 *
 * Exclusions, deliberately SIMPLE and bounded (not a re-implementation of git's ignore
 * engine — that hand-roll was an open-ended edge factory):
 *   - the hard set (node_modules/.git/.fastagent, by name at any depth) always;
 *   - the build ROOT's flat `.gitignore` + `.fastagentignore` (one matcher, fa
 *     authoritative), applied artifact-relative to every entry. NESTED .gitignore (down
 *     the tree) and ANCESTOR .gitignore (up a monorepo) are NOT honored — put such rules
 *     in the root `.fastagentignore`.
 *
 * Symlinks are NOT followed: a symlink entry is skipped entirely (the artifact is
 * self-contained with no links to dereference, and no "link aliases an excluded tree" or
 * cycle edges). `skip` (realpaths) excludes the build's own dirs (staging / target). The
 * ROOT is realpath'd, so building through a symlinked path still resolves the real tree;
 * only symlinks INSIDE the tree are skipped.
 */
async function planShipSet(srcDir: string, opts: { skip?: string[] } = {}): Promise<ShipPlan> {
  const skip = opts.skip ?? [];
  const topBase = await realpath(srcDir).catch(() => resolve(srcDir));
  const files: { abs: string; rel: string }[] = [];
  const dirs: string[] = [];
  const ig = await loadRootIgnore(topBase); // the root's flat ignore matcher, artifact-relative

  async function walk(absDir: string): Promise<void> {
    const realDir = await realpath(absDir).catch(() => resolve(absDir));
    // Skip the build's own dirs (staging + the final publish target) by realpath.
    if (skip.some((s) => realDir === s || realDir.startsWith(s + sep))) return;
    const relDir = toPosix(relative(topBase, absDir));
    if (relDir !== "") dirs.push(relDir); // record dirs so empty (but included) ones survive
    for (const entry of await readdir(absDir, { withFileTypes: true })) {
      if (isHardExcluded(entry.name)) continue;
      if (entry.isSymbolicLink()) continue; // not followed, not shipped
      const isDir = entry.isDirectory();
      if (!isDir && !entry.isFile()) continue; // skip sockets/FIFOs/devices
      const abs = join(absDir, entry.name);
      const rel = toPosix(relative(topBase, abs));
      if (ig?.ignores(isDir ? `${rel}/` : rel)) continue; // dir patterns match with a trailing slash
      if (isDir) await walk(abs);
      else files.push({ abs, rel });
    }
  }
  await walk(topBase);
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
  bundleOpts: { skipPaths?: string[] } = {},
): Promise<LoadedDefinition> {
  const definition = await loadAgentDefinition(srcDir, options);
  const srcReal = await realpath(srcDir).catch(() => resolve(srcDir));
  // skills/ is produced from the model, NOT copied from the tree — so the authored-context
  // walk skips it. realpath it (like the other skip entries), so a SYMLINKED skills/ matches
  // the walk's realpath comparison and isn't copied in as a raw (loser-bearing) tree.
  const skillsDir = await realpath(join(srcReal, "skills")).catch(() => join(srcReal, "skills"));

  // Production 1 — the authored context tree, EXCLUDING skills/. Skip the build's own dirs
  // (staging / final target) too, so output is never bundled into itself.
  const skipHere = await realpath(outDir).catch(() => resolve(outDir));
  const skipExtra = await Promise.all(
    (bundleOpts.skipPaths ?? []).map((p) => realpath(p).catch(() => resolve(p))),
  );
  const plan = await planShipSet(srcDir, { skip: [skipHere, ...skipExtra, skillsDir] });
  const shipped = new Set(plan.files.map((f) => f.rel));

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
    // skill.name is author-supplied (frontmatter) and used here as a PATH segment. Reject a
    // name that isn't a single safe directory component — a slash/backslash, a leading dot,
    // or `.`/`..` could escape skills/ (path traversal) or land where the loader won't find
    // it (artifact != reported). Pi only warns on these; the build must fail visibly.
    if (skill.name === "" || skill.name.startsWith(".") || /[/\\]/.test(skill.name)) {
      throw new Error(
        `skill name "${skill.name}" (${skill.filePath}) is not a valid directory name ` +
          `(no slashes, no leading dot); rename it.`,
      );
    }
    if (basename(skill.filePath) === "SKILL.md") {
      // A skill ships its own dir minus its OWN root .gitignore/.fastagentignore (Fork A);
      // planShipSet roots at the skill dir, so its flat ignore governs it (not the workspace's).
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
