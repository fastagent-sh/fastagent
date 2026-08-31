/**
 * Init: scaffold a runnable fastagent agent, offline. Default = a COMPLETE agent (persona.md +
 * the writing-great-skills skill + a fetch-url code tool + fastagent.config.mjs + package.json +
 * .gitignore + .secrets/); `--minimal` drops the code tool and package.json. persona.md is the agent's
 * identity (prompt segment ①); an existing AGENTS.md is never written or touched — it is project
 * context (②), kept as-is. skills/ and tools/ are the agent's self-editable capabilities (re-read each
 * turn).
 *
 * Placement — no detection and no prompt, just a default and one flag. By DEFAULT the whole agent —
 * definition, config, `.secrets/`, machinery — lands in `<dir>/fastagent/`; the surrounding tree gets
 * ZERO writes and becomes the workspace the agent works on. `--agent-dir <name>` picks another name for
 * that directory (`fastagent.config.*` is the marker of what IS an agent, never the name), and `--agent-dir .`
 * (spelled `--flat`) lands the identical shape in `dir` itself, for the case where the directory IS the
 * agent (a standalone agent repo, a monorepo package).
 *
 * Which of the two a served agent turns out to be is NOT decided here: the workspace is whatever
 * fastagent is later pointed at (resolvePlacement). This module only chooses where the files land — so
 * its one placement duty is to refuse a target that the lookup would not return (see below).
 *
 * Scope: init is best-effort atomic for ORDINARY inputs — it never overwrites existing files,
 * preflights non-directory scaffold parents, and rolls back a partial write (files AND the
 * `fastagent/` tree it created for them, so a retry sees a clean slate). It does not defend against
 * every pathological target state (TOCTOU, FIFOs, disk-full): recover by delete-and-retry.
 *
 * Sibling scaffold modules: add-channel.ts (`add <channel>`), vendor-skill.ts (`add skill`). The files
 * this module writes are real templates under templates/, read through templates.ts.
 */
import { lstat, mkdir, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  AGENT_CONFIG_NAMES,
  DEFAULT_AGENT_DIRNAME,
  SECRETS_DIRNAME,
  agentDefinitionOwner,
  agentsAt,
  displayPath,
  ensureSecretsDir,
  exists,
} from "../paths.ts";
import { baseTemplate, packageJson, toPackageName } from "./templates.ts";
import { fastagentVersion } from "../version.ts";

interface ScaffoldFile {
  rel: string;
  content: string;
}

/** The agent directory name for a raw `--agent-dir` value: the default when unset, and `./bot` read as
 *  `bot` — `basename` already says that is what it means, so rejecting the spelling would be pedantry. */
export function agentDirName(raw: string | undefined): string {
  if (raw === undefined) return DEFAULT_AGENT_DIRNAME;
  const trimmed = raw.replace(/^\.[/\\]/, "");
  return trimmed === "" ? raw : trimmed;
}

/** Why `name` cannot be an agent directory name, or undefined when it can. It must stay ONE segment
 *  inside the target: anything else (a separator, `..`, an absolute path) would land the agent where the
 *  one-level lookup cannot see it — an agent nothing would ever serve.
 *
 *  Returns the CONSTRAINT, not a sentence: the CLI prefixes the flag it owns and reports it as the usage
 *  error it is (exit 2), while {@link scaffoldAgent} prefixes the option name for a programmatic caller,
 *  who never passed a flag and should not be told to fix one. */
export function agentDirNameError(name: string): string | undefined {
  if (name === "." || (name !== "" && name !== ".." && name === basename(name))) return undefined;
  return (
    `must be a single directory name (or "." for the target itself) — a path would put the agent outside ` +
    `the target directory, where fastagent would not find it`
  );
}

export interface ScaffoldOptions {
  /** Scaffold the markdown-only unit (no package.json, no tool, no install) instead of a complete agent. */
  minimal?: boolean;
  /** The agent directory's name inside `dir` — default {@link DEFAULT_AGENT_DIRNAME}, `"."` for `dir`
   *  itself. ONE path segment: a separator or `..` would put the agent outside the directory the author
   *  named, where the one-level lookup could never find it. */
  agentDir?: string;
}

export interface ScaffoldResult {
  dir: string;
  /** Whether a complete (code-tool) agent was scaffolded (false for --minimal). */
  complete: boolean;
  /** The agent dir relative to `dir`: the {@link ScaffoldOptions.agentDir} that was used. */
  agentDir: string;
  /** Files written by this run (relative to `dir`). */
  created: string[];
  /** Files that already existed and were KEPT untouched. Only reachable with `agentDir: "."` (a
   *  subdirectory target is proven empty first): adopting a directory means its `.gitignore`/
   *  `package.json` are the author's. The caller surfaces them — silently skipping a file the user
   *  expected would be worse. */
  kept: string[];
}

/**
 * Scaffold a runnable agent into `<dir>/<agentDir>/` — or into `dir` itself when `agentDir` is `"."`
 * (both created if missing). Default is a complete agent (persona.md + the writing-great-skills skill +
 * a code tool + package.json); `--minimal` drops the code tool and package.json.
 *
 * A SUBDIRECTORY target must be empty (any content there is an unfinished agent or something unrelated,
 * and landing persona.md beside it would be a silent mix), while `"."` is a directory being adopted —
 * content is expected. So `"."` KEEPS every file that already exists (reported, never overwritten, never
 * verified) and refuses only on a config, which means the directory is already an agent. An existing
 * AGENTS.md is untouched either way: that is the project's context, adopted as-is.
 */
export async function scaffoldAgent(dir: string, options: ScaffoldOptions = {}): Promise<ScaffoldResult> {
  const minimal = options.minimal ?? false;
  const root = agentDirName(options.agentDir);
  const flat = root === ".";
  const invalid = agentDirNameError(root);
  if (invalid) throw new Error(`agentDir "${root}" ${invalid}`);
  const skill = (name: string) => ({
    rel: join(root, "skills", "writing-great-skills", name),
    content: baseTemplate(`skills/writing-great-skills/${name}`),
  });
  const files: ScaffoldFile[] = [
    // ① identity. AGENTS.md is deliberately NOT scaffolded: a fresh agent has no project context, and
    // an existing repo already owns its AGENTS.md (kept untouched, read as ② context from the workspace).
    { rel: join(root, "persona.md"), content: baseTemplate("persona.md") },
    // The example skill: how to author skills well — the core of self-iteration. Markdown, so it
    // ships in --minimal too. Vendored verbatim from mattpocock/skills (MIT); LICENSE sits beside it.
    skill("SKILL.md"),
    skill("GLOSSARY.md"),
    skill("LICENSE"),
    { rel: join(root, "fastagent.config.mjs"), content: baseTemplate("fastagent.config.mjs") },
    // Two ignore files, scaffolded ONCE and owned by the author from then on — no command rewrites,
    // reads or verifies them. The agent's own covers node_modules/machinery/a stray .env; `.secrets/`
    // carries its own because the root file is the one the author has reason to edit, and git's
    // nested-ignore precedence keeps the credentials protected whatever happens up there.
    { rel: join(root, ".gitignore"), content: baseTemplate("gitignore") },
    { rel: join(root, SECRETS_DIRNAME, ".gitignore"), content: baseTemplate("secrets.gitignore") },
    { rel: join(root, SECRETS_DIRNAME, ".env.example"), content: baseTemplate("env.example") },
  ];
  if (!minimal) {
    files.push(
      { rel: join(root, "tools", "fetch-url.ts"), content: baseTemplate("tools/fetch-url.ts") },
      // The agent's own manifest, named after the directory it serves (`<dir>-agent`) — except when it
      // IS that directory, where it takes the name straight.
      {
        rel: join(root, "package.json"),
        content: packageJson(flat ? toPackageName(dir) : `${toPackageName(dir)}-agent`, await fastagentVersion()),
      },
    );
  }

  // Inside another agent's DEFINITION (its `skills/`, `tools/`, `channels/` or `schedules/`): the outer
  // agent would load the new one as its own content. Note what this deliberately ALLOWS — a package
  // inside an agent's repository, which is the author's tree and not part of what that agent loads.
  const owner = agentDefinitionOwner(dir);
  if (owner) {
    throw new Error(
      `"${dir}" is inside the definition of the agent at ${owner} — an agent scaffolded here would be ` +
        `part of THAT agent's surface, not one of its own. Init outside it.`,
    );
  }

  // Preflight scaffold parent dirs FIRST: a pre-existing non-directory there would make mkdir fail
  // mid-loop AFTER the first write, leaving a half-scaffold — and a file or symlink named `fastagent`
  // must be named as such here, before the occupancy check below tries to read it as a directory
  // (lstat, not stat: a symlinked parent must be rejected, not followed — it would write outside the
  // agent dir).
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

  // Refuse an occupied agent dir. A config inside means it IS an agent already (name the marker so the
  // message is actionable); any other content means an unfinished agent or something unrelated, and
  // landing persona.md beside it would be a silent mix. Only ENOENT reads as "empty" — any other fault
  // (EACCES…) must surface here rather than as a raw errno mid-write.
  // (AGENTS.md outside is NOT a marker — it is context, adopted untouched.)
  // `.DS_Store`/`.gitkeep`/`.keep` are not evidence of anyone's content: Finder noise, and the standard
  // way to commit an empty directory (someone reserving the name in git ahead of init).
  const occupants = (
    await readdir(join(dir, root)).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return [] as string[];
      throw e;
    })
  ).filter((f) => ![".DS_Store", ".gitkeep", ".keep"].includes(f));
  // Could `dir` still SELECT the agent this run creates? SIBLINGS are fine — several agents at one level
  // is a supported shape (different roles driving one repository), picked between by FASTAGENT_AGENT or
  // the default name. A SHADOW is not: a config AT `dir` wins over everything inside it, so scaffolding
  // under one (or scaffolding one over existing children) makes an agent the lookup can never return.
  // The target itself is never in the way — a config already there means "already an agent", which the
  // refusal below says in those words.
  const existing = agentsAt(dir).filter((a) => a !== resolve(dir, root));
  const shadowed = flat
    ? existing // the new agent lands AT `dir` and hides everything inside it
    : existing.filter((a) => a === resolve(dir)); // an agent AT `dir` hides the new one inside it
  if (shadowed.length > 0) {
    throw new Error(
      `"${dir}" already resolves to ${shadowed.map((a) => displayPath(process.cwd(), a) ?? a).join(", ")} — ` +
        `an agent scaffolded ${flat ? "here" : `in ./${root}/`} would be hidden by it and never served ` +
        `from "${dir}" (an agent AT a directory wins over any inside it). Use that agent, move it away, ` +
        `or init in a different directory.`,
    );
  }

  // ONE coordinate system for both refusals — `displayPath` is the shared policy (relative inside the
  // cwd, absolute when it climbs out); the earlier pair mixed an absolute path with a basename-relative
  // one, in adjacent branches of the same command.
  const target = displayPath(process.cwd(), join(dir, root)) ?? join(dir, root);
  const config = occupants.filter((f) => (AGENT_CONFIG_NAMES as readonly string[]).includes(f));
  if (config.length > 0) {
    throw new Error(`"${target}" already has ${config.join(", ")} — already a fastagent agent`);
  }
  // Only a SUBDIRECTORY target must be empty. `.` is a directory being adopted — content is expected,
  // and every existing file is kept below.
  if (!flat && occupants.length > 0) {
    throw new Error(
      `"${target}" already holds ${occupants.join(", ")} — move it away first, or run ` +
        `\`fastagent init\` in a different directory`,
    );
  }

  // Which directories were OURS to create? "Empty" is not ownership: a user may have pre-created any of
  // them (`--agent-dir .` adopts a directory that can already carry an empty `skills/` or `.secrets/`),
  // and the rollback below must delete only what THIS run made. Recorded before the first write, since
  // afterwards the two are indistinguishable.
  const preexisting = new Set<string>();
  for (const rel of parents) if (await exists(join(dir, rel))) preexisting.add(rel);
  const agentDirExisted = await exists(join(dir, root));
  await mkdir(dir, { recursive: true });
  const created: string[] = [];
  const kept: string[] = [];
  // ONE rollback scope: any failure removes what THIS run created — files AND the directories it made
  // for them. Leaving the empty dirs behind would be worse than untidy: the occupancy refusal above
  // would then report the next `init` as occupied, blaming the user for our own debris.
  //
  // `wx` never clobbers. A subdirectory target was proven empty, so EEXIST means a concurrent writer —
  // an error. `.` is a directory being adopted, so an existing `.gitignore`/`package.json` is the
  // author's — keep it and report it.
  try {
    for (const file of files) {
      const abs = join(dir, file.rel);
      // The secrets dir carries a mode; every other directory here is ordinary. `init` is usually the
      // FIRST of the four writers to create it, and whoever creates it decides the mode for the rest.
      if (basename(dirname(abs)) === SECRETS_DIRNAME) await ensureSecretsDir(dirname(abs));
      else await mkdir(dirname(abs), { recursive: true });
      try {
        await writeFile(abs, file.content, { flag: "wx" });
        created.push(file.rel);
      } catch (e) {
        if (!flat || (e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        kept.push(file.rel);
      }
    }
  } catch (error) {
    // Best-effort rollback of a partial scaffold: anything that won't delete is left behind (the
    // original error below is the one worth surfacing — a cleanup failure must not mask it). Files
    // first, then the directories THIS RUN created, deepest first; `rmdir` additionally removes only
    // what is empty, so a pre-existing sibling inside one of ours is never touched. The agent root goes
    // last, and only when this run created it — "empty" was never proof of ownership. (Reaching here at all takes a
    // real fs fault: the occupancy refusal above proved the target empty, so nothing else can fail
    // mid-loop. The covered case is a permission fault before the first write.)
    for (const rel of created.reverse()) await rm(join(dir, rel), { force: true }).catch(() => {});
    for (const rel of [...parents].sort((a, b) => b.split(sep).length - a.split(sep).length)) {
      if (rel !== root && !preexisting.has(rel)) await rmdir(join(dir, rel)).catch(() => {});
    }
    if (!agentDirExisted) await rmdir(join(dir, root)).catch(() => {});
    throw error;
  }
  return { dir, complete: !minimal, agentDir: root, created, kept };
}
