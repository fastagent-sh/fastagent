/**
 * Workspace path/ignore utilities — engine-neutral (pure fs/path + the `ignore` matcher). Shared by the
 * scaffold (init/add) and the engine's channel discovery, so they live here, not under engines/pi.
 */
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import ignore, { type Ignore } from "ignore";

/**
 * Guard that `<workspaceDir>/<name>` resolves INSIDE the workspace — a symlink that escapes (or an
 * absolute target) is rejected, so discovery/scaffolding never reaches out of the definition directory.
 * A missing target is fine (nothing to guard yet).
 */
export async function assertInsideWorkspace(workspaceDir: string, name: string): Promise<void> {
  const target = join(workspaceDir, name);
  const real = await realpath(target).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT" || e.code === "not_found") return undefined;
    throw e;
  });
  if (real === undefined) return;
  const root = await realpath(workspaceDir).catch(() => resolve(workspaceDir));
  const rel = relative(root, real);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `${target} resolves outside the workspace (${real}) — it must live inside the definition directory; ` +
        `use a real directory or a symlink that stays within it`,
    );
  }
}

/** Load `.gitignore` + `.fastagentignore` from `dir` into one matcher (case-sensitive), or undefined if none. */
export async function loadRootIgnore(dir: string): Promise<Ignore | undefined> {
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
  // ignorecase:false — the library defaults to case-INSENSITIVE, which would make a rule `README.md`
  // also drop an authored `readme.md`. Match git on a case-sensitive filesystem, reproducibly.
  return rules.trim() === "" ? undefined : ignore({ ignorecase: false }).add(rules);
}
