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
import { cp, copyFile, mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
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

/** Names excluded from the artifact unconditionally, at any depth (the secret/dep red line). */
function isHardExcluded(name: string): boolean {
  return name === ".git" || name === "node_modules" || name === ".fastagent" || name === ".env" || name.startsWith(".env.");
}

/** Load the workspace's root `.gitignore` as a matcher (honored on top of the hard excludes). */
async function loadGitignore(srcDir: string): Promise<Ignore | undefined> {
  const content = await readFile(join(srcDir, ".gitignore"), "utf8").catch(() => undefined);
  return content === undefined ? undefined : ignore().add(content);
}

/**
 * Recursively copy srcDir's contents into outDir, applying exclusions. Hand-rolled
 * (not node:fs cp) because cp refuses dest-inside-src, which is exactly the default
 * (`.fastagent/build`); the walk simply skips outDir. Symlinks are dereferenced so the
 * artifact is self-contained; dangling links are skipped.
 */
async function copyCleanTree(srcBase: string, outDir: string, outBase: string, ig: Ignore | undefined): Promise<void> {
  async function walk(relDir: string): Promise<void> {
    const entries = await readdir(relDir === "" ? srcBase : join(srcBase, relDir), { withFileTypes: true });
    for (const entry of entries) {
      const rel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
      const abs = join(srcBase, rel);
      if (abs === outBase || abs.startsWith(outBase + sep)) continue; // never copy outDir into itself
      if (isHardExcluded(entry.name)) continue;
      const isDir = entry.isDirectory();
      if (ig?.ignores(isDir ? `${rel}/` : rel)) continue; // dir patterns match only with a trailing slash
      const dest = join(outDir, rel);
      if (isDir) {
        await mkdir(dest, { recursive: true });
        await walk(rel);
      } else {
        // entry.isFile() or a symlink: copyFile dereferences, giving a self-contained
        // artifact; a dangling symlink is skipped rather than failing the build.
        await copyFile(abs, dest).catch((e: NodeJS.ErrnoException) => {
          if (!entry.isSymbolicLink()) throw e;
        });
      }
    }
  }
  await walk("");
}

/**
 * Bundle (**the "compile" stage of one-click deploy**): materialize a self-contained,
 * relocatable artifact that does NOT depend on the source location — the deployable
 * agent (core-design §10.1/§10.3).
 *
 * Copies the cleaned source TREE (AGENTS.md, skills/, authored context like docs/,
 * fastagent.config.ts, tool source, package.json, …) into outDir, then materializes
 * the winning global/extra skills (which live outside the source) into outDir/skills/.
 * So `start` can run from outDir alone, with authored context resolving relative to it.
 *
 * Excluded from the artifact: secrets (`.env`/`.env.*`), dependencies (`node_modules`,
 * reinstalled at deploy via `npm ci`), VCS (`.git`), machine state (`.fastagent`) —
 * unconditionally — plus anything the workspace's root `.gitignore` ignores. Secrets
 * are injected at runtime, never bundled.
 *
 * Collision rules match loadAgentDefinition (definition-local wins; losers excluded).
 * Non-destructive to the source: only outDir is written/replaced.
 */
export async function bundleAgentDefinition(
  srcDir: string,
  outDir: string,
  options: LoadAgentDefinitionOptions = {},
): Promise<LoadedDefinition> {
  // Guard the destructive rebuild (rm -rf outDir) against catastrophic paths. realpath,
  // not resolve(), so a --out symlinked to the source (or a source reached through a
  // symlink) is caught. A not-yet-created outDir falls back to resolve().
  const srcReal = await realpath(srcDir).catch(() => resolve(srcDir));
  const outReal = await realpath(outDir).catch(() => resolve(outDir));
  if (srcReal === outReal) {
    throw new Error(
      `bundle output dir must differ from the source workspace (got "${outDir}"); use a separate --out (default .fastagent/build)`,
    );
  }
  if (srcReal.startsWith(outReal + sep)) {
    // outDir is an ancestor of srcDir → rm -rf outDir would delete the source.
    throw new Error(`bundle output dir must not contain the source workspace (got out="${outDir}")`);
  }

  const definition = await loadAgentDefinition(srcDir, options);
  const ig = await loadGitignore(srcDir);
  // cp passes source paths based on the srcDir argument, so match its basis (resolve,
  // not realpath) for relative()/containment; realpath was only for the data-loss guard.
  const srcBase = resolve(srcDir);
  const outBase = resolve(outDir);

  // Clean rebuild: replace outDir entirely (guarded above so this can't delete the
  // source). A file dropped from the source cannot survive as a stale artifact.
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  // Copy the cleaned source tree (excludes the hard set + .gitignore + outDir itself).
  await copyCleanTree(srcBase, outDir, outBase, ig);

  // Materialize winning skills that live OUTSIDE the source tree (globals / extra
  // mounts) into outDir/skills/. Definition-local skills already arrived via the tree
  // copy; collision losers are absent from definition.skills, so they are not copied.
  await mkdir(join(outDir, "skills"), { recursive: true });
  for (const skill of definition.skills) {
    const skillAbs = resolve(skill.filePath);
    if (skillAbs === srcBase || skillAbs.startsWith(srcBase + sep)) continue; // local: already copied
    if (basename(skill.filePath) === "SKILL.md") {
      await cp(dirname(skill.filePath), join(outDir, "skills", skill.name), { recursive: true });
    } else {
      await copyFile(skill.filePath, join(outDir, "skills", basename(skill.filePath)));
    }
  }
  return definition;
}
