/** Init: scaffold a runnable fastagent agent, offline. */
import { lstat, mkdir, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  AGENT_CONFIG_NAMES,
  DEFAULT_AGENT_DIRNAME,
  SECRETS_DIRNAME,
  agentDefinitionOwner,
  agentsAt,
  displayPath,
  exists,
} from "../paths.ts";
import { baseTemplate, packageJson, toPackageName } from "./templates.ts";
import { fastagentVersion } from "../version.ts";

interface ScaffoldFile {
  rel: string;
  content: string;
}

/** The agent directory name for a raw `--agent-dir` value: the default when unset, and `./bot` read as `bot`. */
export function agentDirName(raw: string | undefined): string {
  if (raw === undefined) return DEFAULT_AGENT_DIRNAME;
  const trimmed = raw.replace(/^\.[/\\]/, "");
  return trimmed === "" ? raw : trimmed;
}

/** Why `name` cannot be an agent directory name, or undefined when it can. */
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
  /** The agent directory's name inside `dir` — default {@link DEFAULT_AGENT_DIRNAME}, `"."` for `dir` itself. */
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
  /** Files that already existed and were KEPT untouched. */
  kept: string[];
}

/**
 * Scaffold a runnable agent into `<dir>/<agentDir>/` — or into `dir` itself when `agentDir` is `"."` (both created if
 * missing).
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
    // ① identity.
    { rel: join(root, "persona.md"), content: baseTemplate("persona.md") },
    // The example skill: how to author skills well — the core of self-iteration.
    skill("SKILL.md"),
    skill("GLOSSARY.md"),
    skill("LICENSE"),
    { rel: join(root, "fastagent.config.mjs"), content: baseTemplate("fastagent.config.mjs") },
    // Two ignore files, scaffolded ONCE and owned by the author from then on — no command rewrites, reads or verifies
    // them.
    { rel: join(root, ".gitignore"), content: baseTemplate("gitignore") },
    { rel: join(root, SECRETS_DIRNAME, ".gitignore"), content: baseTemplate("secrets.gitignore") },
    { rel: join(root, SECRETS_DIRNAME, ".env.example"), content: baseTemplate("env.example") },
  ];
  if (!minimal) {
    files.push(
      { rel: join(root, "tools", "fetch-url.ts"), content: baseTemplate("tools/fetch-url.ts") },
      // The agent's own manifest, named after the directory it serves (`<dir>-agent`) — except when it IS that
      // directory, where it takes the name straight.
      {
        rel: join(root, "package.json"),
        content: packageJson(flat ? toPackageName(dir) : `${toPackageName(dir)}-agent`, await fastagentVersion()),
      },
    );
  }

  // Inside another agent's DEFINITION (its `skills/`, `tools/`, `channels/` or `schedules/`): the outer agent would
  // load the new one as its own content.
  const owner = agentDefinitionOwner(dir);
  if (owner) {
    throw new Error(
      `"${dir}" is inside the definition of the agent at ${owner} — an agent scaffolded here would be ` +
        `part of THAT agent's surface, not one of its own. Init outside it.`,
    );
  }

  // Preflight scaffold parent dirs FIRST: a pre-existing non-directory there would make mkdir fail mid-loop AFTER the
  // first write, leaving a half-scaffold.
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

  // Refuse an occupied agent dir.
  const occupants = (
    await readdir(join(dir, root)).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return [] as string[];
      throw e;
    })
  ).filter((f) => ![".DS_Store", ".gitkeep", ".keep"].includes(f));
  // Could `dir` still SELECT the agent this run creates?
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

  // ONE coordinate system for both refusals — `displayPath` is the shared policy (relative inside the cwd, absolute
  // when it climbs out).
  const target = displayPath(process.cwd(), join(dir, root)) ?? join(dir, root);
  const config = occupants.filter((f) => (AGENT_CONFIG_NAMES as readonly string[]).includes(f));
  if (config.length > 0) {
    throw new Error(`"${target}" already has ${config.join(", ")} — already a fastagent agent`);
  }
  // Only a SUBDIRECTORY target must be empty.
  if (!flat && occupants.length > 0) {
    throw new Error(
      `"${target}" already holds ${occupants.join(", ")} — move it away first, or run ` +
        `\`fastagent init\` in a different directory`,
    );
  }

  // Which directories were OURS to create?
  const preexisting = new Set<string>();
  for (const rel of parents) if (await exists(join(dir, rel))) preexisting.add(rel);
  const agentDirExisted = await exists(join(dir, root));
  await mkdir(dir, { recursive: true });
  const created: string[] = [];
  const kept: string[] = [];
  // ONE rollback scope: any failure removes what THIS run created — files AND the directories it made for them.
  try {
    for (const file of files) {
      const abs = join(dir, file.rel);
      await mkdir(dirname(abs), { recursive: true });
      try {
        await writeFile(abs, file.content, { flag: "wx" });
        created.push(file.rel);
      } catch (e) {
        if (!flat || (e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        kept.push(file.rel);
      }
    }
  } catch (error) {
    // Best-effort rollback of a partial scaffold.
    for (const rel of created.reverse()) await rm(join(dir, rel), { force: true }).catch(() => {});
    for (const rel of [...parents].sort((a, b) => b.split(sep).length - a.split(sep).length)) {
      if (rel !== root && !preexisting.has(rel)) await rmdir(join(dir, rel)).catch(() => {});
    }
    if (!agentDirExisted) await rmdir(join(dir, root)).catch(() => {});
    throw error;
  }
  return { dir, complete: !minimal, agentDir: root, created, kept };
}
