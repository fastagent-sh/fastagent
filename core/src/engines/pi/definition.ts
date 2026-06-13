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
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
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

/** Load `<dir>/.fastagentignore` as a matcher (extra excludes on top of git + the hard set). */
async function loadFastagentIgnore(dir: string): Promise<Ignore | undefined> {
  let content: string;
  try {
    content = await readFile(join(dir, ".fastagentignore"), "utf8");
  } catch (error) {
    // Only a missing file is normal; an existing-but-unreadable one fails visibly
    // (silently building with no rules could ship files the author meant to exclude).
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`cannot read ${join(dir, ".fastagentignore")}: ${(error as Error).message}`);
  }
  return ignore().add(content);
}

const execFileAsync = promisify(execFile);

/**
 * The files git considers part of the working tree (tracked + untracked, minus ignored),
 * relative to srcDir and POSIX-normalized. `undefined` when srcDir is NOT a git repo (or
 * git is unavailable) — the caller then ships the whole tree. Delegating to git is why we
 * no longer hand-implement .gitignore semantics.
 *
 * A repo whose enumeration FAILS for an operational reason (dubious ownership, corrupt
 * index, buffer overflow, …) must NOT silently degrade to "ship everything" — that would
 * drop .gitignore protection and bundle ignored/generated/private files. So we detect
 * repo-ness separately (rev-parse) and fail visibly if a real repo can't be enumerated.
 */
async function gitLsFiles(srcDir: string): Promise<string[] | undefined> {
  try {
    await execFileAsync("git", ["-C", srcDir, "rev-parse", "--is-inside-work-tree"]);
  } catch {
    return undefined; // not a git repo / git unavailable → ship the whole tree
  }
  // It IS a repo: an enumeration failure here is unexpected — surface it.
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "git",
      ["-C", srcDir, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { maxBuffer: 256 * 1024 * 1024 },
    ));
  } catch (error) {
    throw new Error(`git ls-files failed in the workspace repo: ${(error as Error).message}`);
  }
  return stdout.split("\0").filter((p) => p.length > 0); // git emits POSIX-separated paths
}

/** Normalize a relative path to POSIX separators for git ship-set / ignore lookups (Windows). */
function toPosix(rel: string): string {
  return sep === "/" ? rel : rel.split(sep).join("/");
}

/** A git ship-set as fast lookups: the listed files + every ancestor dir of a listed file. */
interface GitAllow {
  files: Set<string>;
  dirs: Set<string>;
}
function gitAllowFromFiles(files: string[]): GitAllow {
  const fileSet = new Set(files);
  const dirs = new Set<string>();
  for (const f of files) {
    let d = dirname(f);
    while (d && d !== "." && !dirs.has(d)) {
      dirs.add(d);
      d = dirname(d);
    }
  }
  return { files: fileSet, dirs };
}

/**
 * Recursively copy srcDir into destDir, applying the artifact exclusions. Hand-rolled
 * (not node:fs cp) because cp refuses dest-inside-src, which is exactly the default out
 * `.fastagent/build`; the walk skips `skipAbs` (the out dir) instead.
 *
 * Exclusions: the hard set (secrets/deps/vcs/state, by name at any depth) always; `ig`
 * (a `.fastagentignore` matcher rooted at srcDir) when provided; and, when `gitAllow` is
 * given, the git ship-set (a tracked symlink is listed as a file, a regular dir is kept
 * when it holds a tracked file, a regular file when it is listed). The hard set always
 * applies, so an external skill's own `node_modules`/`.git` is never bundled.
 *
 * Symlinks and git submodules (gitlinks) are dereferenced (follow `stat`): a link/gitlink
 * to a directory is recursed into WITHOUT gitAllow (its contents are outside the parent's
 * tracked enumeration), a link to a file is copied, a dangling link is skipped. Cycles
 * (e.g. `link -> .`) are broken by tracking the current recursion STACK of target
 * realpaths — a dir is skipped only when its realpath is its own ancestor; two sibling
 * links to the same target are both kept.
 */
async function copyDirClean(
  srcDir: string,
  destDir: string,
  opts: { ig?: Ignore; skipReal?: string; gitAllow?: GitAllow } = {},
): Promise<void> {
  const { ig, skipReal, gitAllow } = opts;
  const base = resolve(srcDir);
  async function walk(absDir: string, destPath: string, stack: Set<string>, allow: GitAllow | undefined): Promise<void> {
    const realDir = await realpath(absDir).catch(() => resolve(absDir));
    // Skip the out dir by REALPATH, so it is recognized even when src and out are
    // spelled through different symlink aliases (textual compare would descend into
    // the artifact being created → build/build/…).
    if (skipReal !== undefined && (realDir === skipReal || realDir.startsWith(skipReal + sep))) return;
    if (stack.has(realDir)) return; // cycle: realDir is its own ancestor on this descent
    stack.add(realDir);
    await mkdir(destPath, { recursive: true });
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
      const rel = toPosix(relative(base, abs)); // POSIX for ignore + git ship-set lookups (Windows)
      if (ig?.ignores(isDir ? `${rel}/` : rel)) continue; // dir patterns match only with a trailing slash
      // A dir entry recorded by git as a FILE is a symlink or a submodule gitlink: its
      // contents are outside the parent's tracked enumeration, so deref it (recurse
      // without gitAllow). A regular tracked dir is kept when it holds a tracked file.
      const viaFile = allow !== undefined && allow.files.has(rel);
      if (allow !== undefined) {
        const allowed = isDir ? allow.dirs.has(rel) || viaFile : allow.files.has(rel);
        if (!allowed) continue;
      }
      const dest = join(destPath, entry.name);
      if (isDir) await walk(abs, dest, stack, isLink || viaFile ? undefined : allow);
      else await copyFile(abs, dest); // regular file (follows a symlink-to-file)
    }
    stack.delete(realDir); // leave the descent: siblings sharing this target are not a cycle
  }
  await walk(base, resolve(destDir), new Set(), gitAllow);
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
 * Excluded unconditionally: dependencies (`node_modules`, reinstalled at deploy), VCS
 * (`.git`), and machine state (`.fastagent`) — never meaningful to ship. Beyond that the
 * ship-set is git's (in a repo) or the whole tree (otherwise), minus `.fastagentignore`.
 * Secrets are NOT special-cased: the user excludes them via git/.fastagentignore.
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
  // outDir must not CONTAIN srcDir, or rm -rf outDir would delete the source. relative()
  // (not startsWith(outReal + sep)) so the filesystem root "/" is handled: with `--out /`
  // the string trick yields "//" and every path bypasses the guard.
  const outToSrc = relative(outReal, srcReal);
  if (outToSrc !== "" && outToSrc !== ".." && !outToSrc.startsWith(".." + sep) && !isAbsolute(outToSrc)) {
    throw new Error(`bundle output dir must not contain the source workspace (got out="${outDir}")`);
  }

  const definition = await loadAgentDefinition(srcDir, options);
  const fastagentIg = await loadFastagentIgnore(srcDir);
  const srcBase = resolve(srcDir);

  // Ship-set: in a git repo, git decides which files belong (it already applies
  // .gitignore correctly — we no longer reimplement that). Outside a repo, the whole
  // tree ships. Both modes additionally honor .fastagentignore + the hard excludes.
  const gitFiles = await gitLsFiles(srcDir);
  const gitAllow = gitFiles ? gitAllowFromFiles(gitFiles) : undefined;

  // The loaded definition files (AGENTS.md + local skills) ARE the agent; they must
  // ship. If the ship-set (git or .fastagentignore) would drop one, the reported agent
  // would not match the artifact — surface the conflict instead of silently dropping it.
  const wouldShip = (relPosix: string): boolean => {
    if (relPosix.split("/").some(isHardExcluded)) return false;
    if (fastagentIg?.ignores(relPosix)) return false;
    if (gitAllow && !gitAllow.files.has(relPosix)) return false;
    return true;
  };
  const dropped: string[] = [];
  if (definition.instructions !== undefined && !wouldShip("AGENTS.md")) dropped.push("AGENTS.md");
  for (const skill of definition.skills) {
    const skillAbs = resolve(skill.filePath);
    if (skillAbs === srcBase || skillAbs.startsWith(srcBase + sep)) {
      const rel = toPosix(relative(srcBase, skillAbs)); // POSIX for ignore + git ship-set lookups
      if (!wouldShip(rel)) dropped.push(rel);
    }
  }
  if (dropped.length > 0) {
    throw new Error(
      `the agent loads definition file(s) excluded from the artifact: ${dropped.join(", ")}. ` +
        `Un-ignore them (git / .fastagentignore) — they must ship.`,
    );
  }

  // Clean rebuild: replace outDir entirely (guarded above so this can't delete the
  // source). A file dropped from the source cannot survive as a stale artifact.
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  // Copy the ship-set into the artifact. skipReal is the realpath of the now-created
  // outDir, so an in-tree out (.fastagent/build) is skipped even via a symlink alias.
  const skipReal = await realpath(outDir);
  await copyDirClean(srcBase, outDir, { ig: fastagentIg, skipReal, gitAllow });

  // Materialize winning skills that live OUTSIDE the source tree (globals / extra
  // mounts) into outDir/skills/. Definition-local skills already arrived via the tree
  // copy; collision losers are absent from definition.skills. External skills copy with
  // ONLY the hard excludes (their own node_modules/.git never ship); the workspace
  // ship-set / .fastagentignore do not govern an external skill folder, so its SKILL.md
  // always ships.
  await mkdir(join(outDir, "skills"), { recursive: true });
  for (const skill of definition.skills) {
    const skillAbs = resolve(skill.filePath);
    if (skillAbs === srcBase || skillAbs.startsWith(srcBase + sep)) continue; // local: already copied
    if (basename(skill.filePath) === "SKILL.md") {
      await copyDirClean(dirname(skill.filePath), join(outDir, "skills", skill.name));
    } else {
      await copyFile(skill.filePath, join(outDir, "skills", basename(skill.filePath)));
    }
  }
  return definition;
}
