/**
 * `fastagent add skill <source>`: vendor an Agent Skills skill into `<workspace>/skills/<name>/` —
 * copy-in, git-tracked, never a runtime registry. Source is a giget ref (github default), a local
 * path, or a bare name (resolved against the local global skill dirs as an add-time copy source only).
 * Fetch → staging → validate with the runtime loader → atomic replace, so a bad fetch never destroys
 * an existing skill.
 */
import { cp, mkdir, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { type LoadedDefinition, loadAgentDefinition } from "./definition.ts";

/** Derive the destination skill name from a source ref: the last path segment, sans `#ref`. */
function skillNameFromSource(source: string): string {
  const noRef = source.split("#")[0] ?? source;
  return basename(noRef.replace(/\/+$/, ""));
}

/** A local source is an explicit path (./x, ../x, /abs); anything else is a giget ref or a bare name. */
function isLocalSource(source: string): boolean {
  return source.startsWith("./") || source.startsWith("../") || source === "." || isAbsolute(source);
}

/** A bare name (no `/`, no `scheme:`) resolves against the local global skill dirs (see below). */
function isBareName(source: string): boolean {
  return !source.includes("/") && !/^[a-z][a-z0-9+.-]*:/i.test(source);
}

/** Local "global" skill dirs, used ONLY as an add-time vendoring source (a bare `add skill <name>`
 *  copies the match in, git-tracked) — nothing is loaded from here at run time. */
function findGlobalSkillSource(name: string): string | undefined {
  for (const root of [join(homedir(), ".agents", "skills"), join(homedir(), ".pi", "agent", "skills")]) {
    if (existsSync(join(root, name, "SKILL.md"))) return join(root, name);
  }
  return undefined;
}

export interface VendoredSkill {
  /** The skill's real name (from SKILL.md frontmatter, per the Agent Skills spec). */
  name: string;
  description?: string;
  /** Workspace-relative destination (e.g. `skills/pdf`). */
  dest: string;
  /** The skill ships a `scripts/` dir (executable code) — a trust signal for the caller. */
  hasScripts: boolean;
  /** Spec diagnostics for THIS skill from the runtime loader (e.g. name ≠ dir). */
  diagnostics: LoadedDefinition["diagnostics"];
  /** True when an existing skill was overwritten (--update); false for a fresh vendor. */
  overwritten: boolean;
}

/**
 * Vendor an Agent Skills skill into `<workspace>/skills/<name>/` from a giget ref (github default), a
 * local path, or a bare name (resolved against the local global skill dirs). Copy-in, git-tracked.
 * Refuses to overwrite unless `options.update` (then a plain git-tracked overwrite, never a merge).
 * Validates a staging copy with the runtime loader BEFORE replacing, so a bad fetch never destroys an
 * existing skill.
 */
export async function vendorSkill(
  workspaceDir: string,
  source: string,
  options: { update?: boolean } = {},
): Promise<VendoredSkill> {
  const name = skillNameFromSource(source);
  if (name === "" || name === "." || name === "..") {
    throw new Error(`cannot derive a skill name from "${source}" — point at a skill directory (…/skills/<name>)`);
  }
  const skillsDir = join(workspaceDir, "skills");
  const dest = join(skillsDir, name);
  // Refuse to clobber unless --update; the check is side-effect-free, and a git-tracked overwrite is
  // safe (review with `git diff`, undo with `git checkout`).
  const overwritten = existsSync(dest);
  if (overwritten && !options.update) {
    throw new Error(
      `skills/${name} already exists — re-run with --update to overwrite it (git tracks the change), or remove it`,
    );
  }
  await mkdir(skillsDir, { recursive: true });

  // Fetch into a STAGING dir (same filesystem → atomic rename), validate, and only THEN replace dest,
  // so a failed/invalid fetch never destroys an existing skill. The leading "." keeps the loader from
  // treating staging as a skill.
  const staging = join(skillsDir, `.${name}.vendoring`);
  await rm(staging, { recursive: true, force: true }); // clear any leftover from a prior crash
  try {
    if (isLocalSource(source)) {
      const src = resolve(source);
      if (!existsSync(join(src, "SKILL.md"))) {
        throw new Error(`"${source}" has no SKILL.md — an Agent Skills skill is a directory containing SKILL.md`);
      }
      await cp(src, staging, { recursive: true });
    } else if (isBareName(source)) {
      // bare name → vendor from a local global skill dir (add-time copy, not a runtime scan).
      const src = findGlobalSkillSource(source);
      if (!src) {
        throw new Error(
          `no skill "${source}" in your global skill dirs (~/.agents/skills, ~/.pi/agent/skills) — ` +
            `give a git ref (owner/repo/path) or a local path instead`,
        );
      }
      await cp(src, staging, { recursive: true });
    } else {
      // giget defaults a BARE ref to its own template registry, not github — so default the provider to
      // github for a plain `owner/repo/path` (an explicit `github:`/`gh:`/`gitlab:`… scheme is kept).
      // Supports a subdir + #ref, fetched via the tar API (no git binary).
      const ref = /^[a-z][a-z0-9+.-]*:/i.test(source) ? source : `github:${source}`;
      // Lazy import: giget is only needed for a git ref, so the serve path (index.ts → init.ts) and the
      // local/bare-name sources never load it.
      const { downloadTemplate } = await import("giget");
      await downloadTemplate(ref, { dir: staging, force: true });
    }
    if (!existsSync(join(staging, "SKILL.md"))) {
      throw new Error(`"${source}" did not yield a SKILL.md — expected an Agent Skills skill directory`);
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true }); // failed/invalid: drop staging, leave dest intact
    throw error;
  }
  // Validated. Replace atomically — the old skill survived every failure path above.
  if (overwritten) await rm(dest, { recursive: true, force: true });
  await rename(staging, dest);

  // Report via the runtime loader, matching THIS skill by EXACT directory (a substring match would
  // prefix-pollute a sibling `<name>-x` and break on Windows path separators).
  const def = await loadAgentDefinition(workspaceDir);
  const rel = join("skills", name);
  const skill = def.skills.find((sk) => relative(workspaceDir, dirname(sk.filePath)) === rel);
  return {
    name: skill?.name ?? name,
    description: skill?.description,
    dest: rel,
    hasScripts: existsSync(join(dest, "scripts")),
    diagnostics: def.diagnostics.filter((d) => d.path !== undefined && relative(workspaceDir, dirname(d.path)) === rel),
    overwritten,
  };
}
