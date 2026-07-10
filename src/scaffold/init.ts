/**
 * Init: scaffold a runnable fastagent workspace, offline. Default = a COMPLETE agent (persona.md +
 * the writing-great-skills skill + a fetch-url code tool + fastagent.config.mjs + package.json +
 * .gitignore); `--minimal` drops the code tool and package.json. persona.md is the agent's identity
 * (prompt segment ①); an existing AGENTS.md is never written or touched — it is project context (②),
 * kept as-is. skills/ and tools/ are the agent's self-editable capabilities (re-read each turn).
 *
 * Layout (the jurisdiction rule — core.md scenario grid): the agent kit goes FLAT into `dir` ("a
 * directory is an agent") UNLESS an existing system already CLAIMS the tree — a toolchain config that
 * sweeps files by pattern (tsconfig/framework configs), a deploy manifest (Dockerfile/fly/railway/…),
 * or fastagent's own convention names already occupied (non-empty tools//channels//skills/). Any such
 * signal → the kit defaults into `./agent` (its own namespace; `config.agentDir` points there), so the
 * host's toolchain and the agent's surface never sweep each other. {@link detectHostSignals} detects;
 * the CLI decides (flags override) and reports the reason.
 *
 * Scope: init is best-effort atomic for ORDINARY inputs — it never overwrites existing files,
 * preflights non-directory scaffold parents, and rolls back a partial write (one exception: the
 * .gitignore APPEND is not rolled back — idempotent, harmless residue). It does not defend against
 * every pathological target state (TOCTOU, FIFOs, disk-full): recover by delete-and-retry.
 *
 * Sibling scaffold modules: add-channel.ts (`add <channel>`), vendor-skill.ts (`add skill`). The files
 * this module writes are real templates under templates/, read through templates.ts.
 */
import { access, appendFile, lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { WORKSPACE_CONFIG_NAMES } from "../engines/pi/config.ts";
import { detectRuntime, readPackageJson } from "../runtime.ts";
import { loadRootIgnore } from "../workspace.ts";
import { baseTemplate, configTemplate, packageJson, personaTemplate, toPackageName } from "./templates.ts";
import { fastagentVersion } from "../version.ts";

interface ScaffoldFile {
  rel: string;
  content: string;
}

export interface ScaffoldOptions {
  /** Scaffold the markdown-only unit (no package.json, no tool, no install) instead of a complete agent. */
  minimal?: boolean;
  /**
   * Place the agent kit (persona.md/skills/tools/package.json) in this subdirectory (e.g. "./agent")
   * instead of flat in `dir`; the config is written at the root with `agentDir` pointing there.
   * Undefined = flat. The CLI decides (jurisdiction detection + flags); this stays mechanical.
   */
  agentDir?: string;
}

export interface ScaffoldResult {
  dir: string;
  /** Whether a complete (code-tool) agent was scaffolded (false for --minimal). */
  complete: boolean;
  /** The kit subdirectory in effect (relative, e.g. "./agent"); undefined = flat. */
  agentDir?: string;
  /** Files written by this run (relative paths). */
  created: string[];
  /** Files that already existed and were kept untouched (e.g. a pre-existing .gitignore). */
  skipped: string[];
  /** Kept ignore files appended with missing fastagent excludes (root .gitignore: .env/.fastagent, plus
   *  node_modules/ in the flat layout; kit .gitignore in the agentDir layout: node_modules/). */
  patched: string[];
  /** True if the target already had content before this run (init into an existing/non-empty dir). */
  intoNonEmpty: boolean;
  /** Non-fatal advisories the caller MUST surface. */
  warnings: string[];
}

/** Filename marks of a system that claims files by pattern (a build toolchain — F2 in the jurisdiction
 *  rule). Not JS-only: a Python/Go/Rust/JVM/Ruby/PHP project's build system claims its tree exactly the
 *  same way — an AGENTS.md-carrying Go repo must not get a flat kit (with a package.json!) in its root.
 *  Deliberately absent: `Makefile` (too generic — notes/dotfiles repos carry one without a toolchain). */
const TOOLCHAIN_RE =
  /^(tsconfig\.json|(next|vite|astro|svelte|nuxt|remix|webpack|rollup)\.config\.[cm]?[jt]s|go\.mod|Cargo\.toml|pyproject\.toml|setup\.py|requirements\.txt|Gemfile|pom\.xml|build\.gradle(\.kts)?|composer\.json|CMakeLists\.txt)$/;
/** Filename marks of a deploy manifest — the tree ships as a non-agent unit (F4). */
const DEPLOY_RE = /^(Dockerfile|fly\.toml|railway\.toml|vercel\.json|netlify\.toml)$/;

/**
 * Jurisdiction signals: evidence that an existing system already claims this tree, so a flat agent kit
 * would put each side's files under the other's jurisdiction (host tsc sweeps agent .ts; fastagent
 * scans host tools/). Three classes, derived from the actual failure modes — a toolchain config, a
 * deploy manifest, or fastagent's convention names already occupied. Any hit → the kit defaults into
 * `./agent`. Deliberately NOT signals: "dir is non-empty", "has package.json", "has src/" — markdown
 * and loose scripts are claimed by nobody, and "a directory is an agent" stays the default. Known
 * tradeoff, decided for visibility: a HAND-BUILT agent dir (skills//tools/ authored for the agent, no
 * config yet) also hits the occupation signal and defaults to ./agent — wrong for that case, but the
 * reason is printed and `--flat` overrides; the reverse default would silently mis-scan a host's dirs.
 */
export async function detectHostSignals(dir: string): Promise<string[]> {
  // Only ENOENT/ENOTDIR mean "nothing there" (fresh dir → flat). A real IO failure (EACCES…) must
  // surface, not silently decide the layout — init is about to write into this directory anyway.
  const absent = (err: unknown): never[] => {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw err;
  };
  const signals: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(absent);
  for (const e of entries) {
    if (e.isFile() && (TOOLCHAIN_RE.test(e.name) || DEPLOY_RE.test(e.name))) signals.push(e.name);
  }
  for (const name of ["tools", "channels", "skills"]) {
    const st = await lstat(join(dir, name)).catch((err: unknown) => {
      absent(err);
      return undefined;
    });
    // Dotfiles (.DS_Store, .gitkeep) are not agent surface — the loaders would never scan them, so
    // they must not count as "occupied" either (the signal mirrors what fastagent would actually scan).
    const occupants = st?.isDirectory()
      ? (await readdir(join(dir, name)).catch(absent)).filter((f) => !f.startsWith("."))
      : [];
    if (occupants.length > 0) signals.push(`${name}/`);
  }
  return signals.sort();
}

/** The `cd` target to show in `init`'s next-steps: the relative path when the target is inside `cwd`,
 *  the absolute path when it climbs out (a `../../..` is noise), or undefined when already in `cwd`. */
export function nextStepCd(cwd: string, dir: string): string | undefined {
  const rel = relative(cwd, dir);
  if (rel === "") return undefined;
  // "Climbs out" is a path-SEGMENT check — rel is ".." or starts with "../" (or "..\" on Windows). A
  // bare startsWith("..") would wrongly flag an in-cwd directory literally named "..agent".
  const escapes = rel === ".." || /^\.\.[/\\]/.test(rel);
  return escapes ? dir : rel;
}

/** Does a path exist? (async; shared with the sibling scaffold modules). */
export async function exists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}

/**
 * Scaffold a runnable workspace into {@link dir} (created if missing). Default is a complete agent
 * (persona.md + the writing-great-skills skill + a code tool + package.json); `--minimal` drops the
 * code tool and package.json. The kit goes flat into `dir`, or into {@link ScaffoldOptions.agentDir}
 * (config at the root pointing there). Refuses only an existing fastagent.config.* (the ownership
 * marker — already a workspace); every other pre-existing file (AGENTS.md, .gitignore, package.json)
 * is kept, never overwritten — an existing AGENTS.md is the project's context, adopted as-is.
 */
export async function scaffoldWorkspace(dir: string, options: ScaffoldOptions = {}): Promise<ScaffoldResult> {
  const minimal = options.minimal ?? false;
  const kit = options.agentDir ?? "."; // where the agent's own surface lands
  const skill = (name: string) => ({
    rel: join(kit, "skills", "writing-great-skills", name),
    content: baseTemplate(`skills/writing-great-skills/${name}`),
  });
  const files: ScaffoldFile[] = [
    // ① identity. AGENTS.md is deliberately NOT scaffolded: a fresh agent has no project context, and
    // an existing repo already owns its AGENTS.md (kept untouched, read as ② context from cwd).
    { rel: join(kit, "persona.md"), content: personaTemplate(options.agentDir) },
    // The example skill: how to author skills well — the core of self-iteration. Markdown, so it
    // ships in --minimal too. Vendored verbatim from mattpocock/skills (MIT); LICENSE sits beside it.
    skill("SKILL.md"),
    skill("GLOSSARY.md"),
    skill("LICENSE"),
    // Run-root pieces: the config (carrying agentDir when the kit is a subdir), secrets hygiene, env template.
    { rel: "fastagent.config.mjs", content: configTemplate(options.agentDir) },
    { rel: ".gitignore", content: baseTemplate(options.agentDir ? "gitignore.agentdir-root" : "gitignore") },
    { rel: ".env.example", content: baseTemplate("env.example") },
  ];
  if (!minimal) {
    files.push(
      { rel: join(kit, "tools", "fetch-url.ts"), content: baseTemplate("tools/fetch-url.ts") },
      // The kit's own manifest: in the agentDir layout the agent self-contains its deps, so the host's
      // package.json/lockfile is never touched. The name says WHOSE agent it is (the workspace's), not
      // which subdirectory it happens to live in.
      {
        rel: join(kit, "package.json"),
        content: packageJson(
          options.agentDir ? `${toPackageName(dir)}-agent` : toPackageName(dir),
          await fastagentVersion(),
        ),
      },
      ...(options.agentDir ? [{ rel: join(kit, ".gitignore"), content: baseTemplate("gitignore.kit") }] : []),
    );
  }

  // Guard on the ownership marker: a config means "already a fastagent workspace". Fail visibly
  // rather than double-initialize. (AGENTS.md is NOT a marker — it is context, adopted untouched.)
  const conflicts: string[] = [];
  for (const name of WORKSPACE_CONFIG_NAMES) if (await exists(join(dir, name))) conflicts.push(name);
  if (conflicts.length > 0) {
    throw new Error(`"${dir}" already has ${conflicts.join(", ")} — already a fastagent workspace`);
  }

  // Never merge the kit into an existing NON-EMPTY directory (a host repo may own an unrelated `agent/`
  // — common in AI products): wx would keep its files, but persona.md/skills/ landing inside someone
  // else's code dir is a silent mix. Refuse with the way out. Dotfiles (.DS_Store, .gitkeep) don't
  // count — same rule as detectHostSignals' occupation check. A SYMLINKED kit path slips past this
  // readdir (it follows links) — deliberate: the parent preflight below lstat-rejects it before any write.
  if (options.agentDir) {
    const occupants = (await readdir(join(dir, kit)).catch(() => [] as string[])).filter((f) => !f.startsWith("."));
    if (occupants.length > 0) {
      throw new Error(
        `"${kit}" already exists and is not empty — if it is unrelated to the agent, pick another name ` +
          `(--agent-dir <name>) or go flat (--flat); to adopt it as the kit, empty it first`,
      );
    }
  }

  // Was the target non-empty BEFORE we wrote anything? (missing dir = empty).
  const intoNonEmpty = (await readdir(dir).catch(() => [] as string[])).length > 0;

  // Preflight scaffold parent dirs: a pre-existing non-directory there would make mkdir fail mid-loop
  // AFTER the first write, leaving a half-scaffold. Detect it before any write (lstat, not stat: a
  // symlinked parent must be rejected, not followed — it would write outside the workspace).
  const parents = new Set<string>();
  for (const file of files) {
    let p = dirname(file.rel);
    while (p !== "." && p !== "") {
      parents.add(p);
      p = dirname(p);
    }
  }
  for (const rel of parents) {
    const st = await lstat(join(dir, rel)).catch(() => undefined);
    if (st && !st.isDirectory()) {
      throw new Error(
        `cannot scaffold: "${rel}" exists and is not a directory (a regular file or symlink) — remove it, or init elsewhere`,
      );
    }
  }

  await mkdir(dir, { recursive: true });
  const created: string[] = [];
  const skipped: string[] = [];
  const patched: string[] = [];
  const warnings: string[] = [];
  // ONE rollback scope: any failure removes files written THIS run (guard + wx guarantee they are
  // ours), so scaffoldWorkspace is atomic — except the .gitignore APPEND below, which is not rolled
  // back (the residue is idempotent, harmless ignore lines; removing someone else's file's tail is riskier).
  try {
    for (const file of files) {
      const abs = join(dir, file.rel);
      await mkdir(dirname(abs), { recursive: true });
      try {
        await writeFile(abs, file.content, { flag: "wx" }); // wx: never clobber
        created.push(file.rel);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") skipped.push(file.rel);
        else throw error;
      }
    }

    // Ignore ownership follows layout jurisdiction. Run-root state/secrets live at `dir`, so the ROOT
    // .gitignore owns `.env` + `.fastagent`. The kit's npm deps live where the kit lives: flat → root
    // `node_modules/`; agentDir → `<agentDir>/.gitignore` owns its own `node_modules/`. This avoids
    // patching a host repo's root ignore with agent-internal dependency paths while still preventing the
    // post-init 25k-file untracked flood.
    const coveredBy = (ig: Awaited<ReturnType<typeof loadRootIgnore>> | undefined, p: string) =>
      (ig?.ignores(p) ?? false) || (ig?.ignores(`${p}/`) ?? false);
    const rootIgnore = await loadRootIgnore(dir);
    const rootRequired = [
      { path: ".env", pattern: ".env" },
      { path: ".fastagent", pattern: ".fastagent" },
      ...(!minimal && !options.agentDir ? [{ path: "node_modules", pattern: "node_modules/" }] : []),
    ];
    const rootNeed = rootRequired.filter((e) => !coveredBy(rootIgnore, e.path));
    if (rootNeed.length > 0) {
      await appendFile(join(dir, ".gitignore"), `\n# fastagent\n${rootNeed.map((e) => e.pattern).join("\n")}\n`);
      patched.push(".gitignore");
      // A .fastagentignore is applied LAST and can re-include what .gitignore excludes — the append
      // cannot fix that, so re-check and keep it a visible warning instead of false assurance.
      const after = await loadRootIgnore(dir);
      const still = rootNeed.filter((e) => !coveredBy(after, e.path)).map((e) => e.path);
      if (still.length > 0) {
        warnings.push(
          `your .gitignore/.fastagentignore does not exclude ${still.map((s) => `"${s}"`).join(", ")} — a deploy that copies the directory may ship secrets/state`,
        );
      }
    }
    if (!minimal && options.agentDir) {
      // Deliberately checks ONLY the kit's own ignore, not the root: the kit is the portable agent
      // directory, and its dependency ignore must travel WITH it (a fresh kit .gitignore carries
      // node_modules/ unconditionally for the same reason) — a root-level `node_modules/` that happens
      // to cover it today doesn't survive the kit being copied out of the host repo.
      const kitIgnore = await loadRootIgnore(join(dir, kit));
      if (!coveredBy(kitIgnore, "node_modules")) {
        const rel = join(kit, ".gitignore");
        await appendFile(join(dir, rel), `\n# fastagent\nnode_modules/\n`);
        patched.push(rel);
      }
    }
    // A kept package.json won't carry the tool's deps — the example tool would not resolve. The install
    // command matches the workspace's runtime (bun.lock → bun add).
    const keptPkg = join(kit, "package.json");
    if (!minimal && skipped.includes(keptPkg)) {
      const kitAbs = join(dir, kit);
      const add = detectRuntime(kitAbs, await readPackageJson(kitAbs)).runtime === "bun" ? "bun add" : "npm install";
      warnings.push(
        `kept the existing ${keptPkg} — run \`${add} @fastagent-sh/fastagent\` there so the example tool resolves`,
      );
    }
  } catch (error) {
    // Best-effort rollback of a partial scaffold: a file that won't delete is left behind (the original
    // error below is the one worth surfacing — a cleanup failure must not mask it).
    for (const rel of created.reverse()) await rm(join(dir, rel), { force: true }).catch(() => {});
    throw error;
  }
  return { dir, complete: !minimal, agentDir: options.agentDir, created, skipped, patched, intoNonEmpty, warnings };
}
