/**
 * Init: scaffold a runnable fastagent workspace, offline. Default = a COMPLETE agent (AGENTS.md +
 * the writing-great-skills skill + a fetch-url code tool + fastagent.config.mjs + package.json +
 * .gitignore); `--minimal` drops the code tool and package.json (AGENTS.md + skill + config only).
 * AGENTS.md IS the system prompt; skills/ and tools/ are the agent's self-editable capabilities
 * (directory is the agent, re-read each turn); .gitignore lists `.env`.
 *
 * Scope: init is best-effort atomic for ORDINARY inputs — it never overwrites an existing workspace,
 * preflights non-directory scaffold parents, and rolls back a partial write. It does not defend
 * against every pathological target state (TOCTOU, FIFOs, disk-full): recover by delete-and-retry.
 *
 * Sibling scaffold modules: add-channel.ts (`add <channel>`), vendor-skill.ts (`add skill`). The files
 * this module writes are real templates under templates/, read through templates.ts.
 */
import { access, appendFile, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { WORKSPACE_CONFIG_NAMES } from "../engines/pi/config.ts";
import { detectRuntime } from "../runtime.ts";
import { loadRootIgnore } from "../workspace.ts";
import { baseTemplate, packageJson, toPackageName } from "./templates.ts";
import { fastagentVersion } from "../version.ts";

interface ScaffoldFile {
  rel: string;
  content: string;
}

export interface ScaffoldOptions {
  /** Scaffold the markdown-only unit (no package.json, no tool, no install) instead of a complete agent. */
  minimal?: boolean;
}

export interface ScaffoldResult {
  dir: string;
  /** Whether a complete (code-tool) agent was scaffolded (false for --minimal). */
  complete: boolean;
  /** Files written by this run (relative paths). */
  created: string[];
  /** Files that already existed and were kept untouched (e.g. a pre-existing .gitignore). */
  skipped: string[];
  /** True if the target already had content before this run (init into an existing/non-empty dir). */
  intoNonEmpty: boolean;
  /** Non-fatal advisories the caller MUST surface. */
  warnings: string[];
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

export interface AdoptResult {
  dir: string;
  /** Files created by adopt (fastagent.config.mjs, and .gitignore if there was none). */
  created: string[];
  /** Files appended to (.gitignore, to exclude secrets/state). */
  patched: string[];
  /** The workspace's JS runtime — drives the dep-install hint (bun add vs npm install). */
  runtime: "node" | "bun";
  /** Whether a package.json is present (a channel needs one). */
  hasPackageJson: boolean;
  /** Whether @kid7st/fastagent is already a dependency (a channel imports it). */
  hasFastagentDep: boolean;
}

/**
 * ADOPT an existing repo (it already has AGENTS.md) into a fastagent workspace, instead of refusing it.
 * This is the B-mode on-ramp: the repo IS the agent, so adopt adds ONLY the missing fastagent piece —
 * `fastagent.config.mjs` — and makes secrets safe (.gitignore excludes `.env`/`.fastagent`). It never
 * writes or clobbers AGENTS.md / skills / tools (the repo's own), and never hand-edits package.json (the
 * package manager owns the lockfile — the caller PRINTS the right `bun add`/`npm install` for {@link
 * AdoptResult.runtime} instead). Precondition (caller-checked): AGENTS.md present, no fastagent.config.*.
 */
export async function adoptWorkspace(dir: string): Promise<AdoptResult> {
  const created: string[] = [];
  const patched: string[] = [];

  // The one missing piece for an existing-AGENTS.md repo: the config (model + deploy knobs).
  await writeFile(join(dir, "fastagent.config.mjs"), baseTemplate("fastagent.config.mjs"), { flag: "wx" });
  created.push("fastagent.config.mjs");

  // Secrets/state must not ship in a deploy copy: ensure .gitignore excludes .env and .fastagent.
  const rootIgnore = await loadRootIgnore(dir);
  const need = [".env", ".fastagent"].filter((p) => !rootIgnore?.ignores(p));
  if (need.length > 0) {
    const gitignore = join(dir, ".gitignore");
    const had = await exists(gitignore);
    await appendFile(gitignore, `${had ? "\n" : ""}# fastagent\n${need.join("\n")}\n`);
    (had ? patched : created).push(".gitignore");
  }

  // Runtime + dep status for the caller's next-steps (adopt guides; it does not touch package.json).
  const hasPackageJson = await exists(join(dir, "package.json"));
  let pkg: {
    packageManager?: unknown;
    dependencies?: Record<string, unknown>;
    devDependencies?: Record<string, unknown>;
  } = {};
  if (hasPackageJson) {
    try {
      pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    } catch {
      /* malformed — the runtime hint degrades to node; the user's build would surface the real error */
    }
  }
  const { runtime } = detectRuntime(dir, pkg);
  const hasFastagentDep = "@kid7st/fastagent" in { ...pkg.dependencies, ...pkg.devDependencies };
  return { dir, created, patched, runtime, hasPackageJson, hasFastagentDep };
}

/**
 * Scaffold a runnable workspace into {@link dir} (created if missing). Default is a complete agent
 * (instructions + the writing-great-skills skill + a code tool + package.json); `--minimal` drops
 * the code tool and package.json. Refuses to overwrite an existing agent identity (AGENTS.md or any
 * fastagent.config.*); other pre-existing files (.gitignore, package.json) are kept, not overwritten.
 */
export async function scaffoldWorkspace(dir: string, options: ScaffoldOptions = {}): Promise<ScaffoldResult> {
  const minimal = options.minimal ?? false;
  const skill = (name: string) => ({
    rel: join("skills", "writing-great-skills", name),
    content: baseTemplate(`skills/writing-great-skills/${name}`),
  });
  const files: ScaffoldFile[] = [
    { rel: "AGENTS.md", content: baseTemplate("AGENTS.md") },
    // The example skill: how to author skills well — the core of self-iteration. Markdown, so it
    // ships in --minimal too. Vendored verbatim from mattpocock/skills (MIT); LICENSE sits beside it.
    skill("SKILL.md"),
    skill("GLOSSARY.md"),
    skill("LICENSE"),
    { rel: "fastagent.config.mjs", content: baseTemplate("fastagent.config.mjs") },
    { rel: ".gitignore", content: baseTemplate("gitignore") },
    { rel: ".env.example", content: baseTemplate("env.example") },
  ];
  if (!minimal) {
    files.push(
      { rel: join("tools", "fetch-url.ts"), content: baseTemplate("tools/fetch-url.ts") },
      { rel: "package.json", content: packageJson(toPackageName(dir), await fastagentVersion()) },
    );
  }

  // Guard on the identity files: their presence means "already a workspace". Fail visibly
  // rather than overwrite authored content. Same WORKSPACE_CONFIG_NAMES the CLI's adopt-vs-scaffold
  // routing reads, so routing and refusal never disagree about whether a config exists.
  const conflicts: string[] = [];
  if (await exists(join(dir, "AGENTS.md"))) conflicts.push("AGENTS.md");
  for (const name of WORKSPACE_CONFIG_NAMES) if (await exists(join(dir, name))) conflicts.push(name);
  if (conflicts.length > 0) {
    throw new Error(`"${dir}" already has ${conflicts.join(", ")} — init refuses to overwrite an existing workspace`);
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
  const warnings: string[] = [];
  // ONE rollback scope: any failure removes files written THIS run (guard + wx guarantee they are
  // ours), so scaffoldWorkspace is atomic.
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

    // A deploy that copies the dir ships secrets unless .gitignore/.fastagentignore exclude them. Use
    // loadRootIgnore (the same matcher) so the advisory matches what would ship; a kept .gitignore
    // that doesn't ignore .env means the scaffold's secret line silently didn't take effect.
    const rootIgnore = await loadRootIgnore(dir);
    if (!rootIgnore?.ignores(".env")) {
      warnings.push(
        `your .gitignore/.fastagentignore does not exclude ".env" — add it, or a deploy that copies the directory may ship secrets`,
      );
    }
    // A kept package.json won't carry the tool's deps — the example tool would not resolve.
    if (!minimal && skipped.includes("package.json")) {
      warnings.push(
        `kept your existing package.json — add "@kid7st/fastagent" and "zod" to its dependencies to use code tools`,
      );
    }
  } catch (error) {
    // Best-effort rollback of a partial scaffold: a file that won't delete is left behind (the original
    // error below is the one worth surfacing — a cleanup failure must not mask it).
    for (const rel of created.reverse()) await rm(join(dir, rel), { force: true }).catch(() => {});
    throw error;
  }
  return { dir, complete: !minimal, created, skipped, intoNonEmpty, warnings };
}
