/** Init: scaffold a runnable fastagent agent, offline. */
import { lstat, mkdir, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { AGENT_CONFIG_FILE, SECRETS_DIRNAME, displayPath, enclosingAgentDir } from "../paths.ts";
import { baseTemplate, packageJson, toPackageName } from "./templates.ts";
import { fastagentVersion } from "../version.ts";

interface ScaffoldFile {
  rel: string;
  content: string;
}

export interface ScaffoldResult {
  /** The agent directory: `dir` itself. */
  dir: string;
  /** Files written by this run (relative to `dir`). */
  created: string[];
}

/** Entries a directory may hold and still count as empty. */
const IGNORABLE = [".DS_Store", ".gitkeep", ".keep"];

/**
 * Scaffold a runnable agent INTO `dir`, which must be new or empty. An agent is a directory of its own: what it works
 * on is declared, never the directory around it.
 */
export async function scaffoldAgent(dir: string): Promise<ScaffoldResult> {
  const skill = (name: string) => ({
    rel: join("skills", "writing-great-skills", name),
    content: baseTemplate(`skills/writing-great-skills/${name}`),
  });
  const files: ScaffoldFile[] = [
    // Standing instructions, added to pi's default prompt (SYSTEM.md would replace it).
    { rel: "APPEND_SYSTEM.md", content: baseTemplate("APPEND_SYSTEM.md") },
    // The example skill: how to author skills well — the core of self-iteration.
    skill("SKILL.md"),
    skill("GLOSSARY.md"),
    skill("LICENSE"),
    { rel: AGENT_CONFIG_FILE, content: baseTemplate(AGENT_CONFIG_FILE) },
    // Two ignore files, scaffolded ONCE and owned by the author from then on — no command rewrites, reads or verifies
    // them.
    { rel: ".gitignore", content: baseTemplate("gitignore") },
    { rel: join(SECRETS_DIRNAME, ".gitignore"), content: baseTemplate("secrets.gitignore") },
    { rel: join(SECRETS_DIRNAME, ".env.example"), content: baseTemplate("env.example") },
    { rel: join("tools", "fetch-url.ts"), content: baseTemplate("tools/fetch-url.ts") },
    // The agent's own manifest, named after its directory.
    { rel: "package.json", content: packageJson(toPackageName(dir), await fastagentVersion()) },
  ];

  const shown = displayPath(process.cwd(), dir) ?? dir;
  // Inside another agent: that agent's directory is its own definition and working directory, so the new one would be
  // read as part of it.
  const owner = enclosingAgentDir(dir);
  if (owner) {
    throw new Error(
      `"${shown}" is inside the agent ${owner} — an agent is a directory of its own; create it outside that one`,
    );
  }
  const st = await lstat(dir).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return undefined;
    throw e;
  });
  if (st && !st.isDirectory()) throw new Error(`"${shown}" exists and is not a directory`);
  const occupants = st ? (await readdir(dir)).filter((name) => !IGNORABLE.includes(name)) : [];
  if (occupants.includes(AGENT_CONFIG_FILE)) {
    throw new Error(`"${shown}" already has ${AGENT_CONFIG_FILE} — already a fastagent agent`);
  }
  if (occupants.length > 0) {
    throw new Error(
      `"${shown}" is not empty (it holds ${occupants.join(", ")}) — an agent lives in a directory of its own; to ` +
        `have one work on this directory: \`fastagent init <new directory> --context ${displayPath(process.cwd(), dir) ?? "."}\``,
    );
  }

  const parents = new Set<string>();
  for (const file of files) {
    for (let p = dirname(file.rel); p !== "." && p !== ""; p = dirname(p)) parents.add(p);
  }
  const dirExisted = st !== undefined;
  await mkdir(dir, { recursive: true });
  const created: string[] = [];
  // ONE rollback scope: any failure removes what THIS run created — files AND the directories it made for them.
  // `wx` so a collision is a failure: the target was checked empty above, so anything here appeared mid-run.
  try {
    for (const file of files) {
      const abs = join(dir, file.rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, file.content, { flag: "wx" });
      created.push(file.rel);
    }
  } catch (error) {
    // Best-effort rollback of a partial scaffold.
    for (const rel of created.reverse()) await rm(join(dir, rel), { force: true }).catch(() => {});
    for (const rel of [...parents].sort((a, b) => b.split(sep).length - a.split(sep).length)) {
      await rmdir(join(dir, rel)).catch(() => {});
    }
    if (!dirExisted) await rmdir(dir).catch(() => {});
    throw error;
  }
  return { dir, created };
}
