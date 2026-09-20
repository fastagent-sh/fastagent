/**
 * Routine discovery: an agent declares its named units of work by dropping files in `routines/`, mirroring
 * `tools/` and `channels/`.
 */
import { join } from "node:path";
import { type ModuleLoadFailure, loadModuleDir } from "../loader.ts";
import { type DeclaredSecret, readSecretDeclaration } from "../declared-secrets.ts";
import { assertInsideAgentDir } from "../paths.ts";
import { cronError } from "./cron.ts";
import { isSafeScheduleName } from "./state.ts";
import type { LoadedRoutine, Routine } from "./routine.ts";

/**
 * Discover routines in `<dir>/routines/`: each file default-exports a `defineRoutine({...})`, named from its
 * filename.
 */
export async function loadRoutines(dir: string): Promise<{
  routines: LoadedRoutine[];
  /** What each loaded routine declared it needs, BY ROUTINE NAME and attributed to its file. Per
   *  routine because a caller that runs exactly ONE of them (`fastagent routine run`) must not be stopped
   *  by a sibling's credential, and because two routines declaring the same variable would
   *  otherwise blame whichever file was read first. The clock flattens it (it runs all of them).
   *  Data, not a check — only a serving path asserts it (src/declared-secrets.ts). */
  secrets: Map<string, DeclaredSecret[]>;
  failures: ModuleLoadFailure[];
}> {
  await assertInsideAgentDir(dir, "routines");
  const { modules, failures } = await loadModuleDir(join(dir, "routines"));
  const byName = new Map<string, LoadedRoutine>();
  const secrets = new Map<string, DeclaredSecret[]>();
  for (const { name, label, file, mod } of modules) {
    try {
      const r = mod.default as Partial<Routine> | undefined;
      if (!r || typeof r.prompt !== "string") {
        throw new Error(`${label} must default-export defineRoutine({ prompt, cron? })`);
      }
      const declaration = readSecretDeclaration(r, label);
      if (declaration.error !== undefined) throw new Error(declaration.error);
      // NO CRON IS NOT AN ERROR: the routine is then reachable by name only (`POST /run`, the CLI, a scheduler
      // that calls the route). A `tz` without one is, though — it would read as a time this routine does not have.
      if (r.cron !== undefined && typeof r.cron !== "string") throw new Error(`${label}: "cron" must be a string`);
      if (r.cron === undefined && r.tz !== undefined) {
        throw new Error(`${label}: "tz" means nothing without "cron" — remove it, or give this routine a cron`);
      }
      if (r.cron !== undefined) {
        const err = cronError(r.cron, r.tz);
        if (err) throw new Error(`${label}: invalid cron/tz — ${err}`);
      }
      // The name becomes a path segment (the fired-slot claims live under `claims/<name>/`), so anything that could
      // leave that directory is refused here — where the author sees which file is wrong — rather than deeper.
      if (!isSafeScheduleName(name)) {
        throw new Error(`${label}: a routine name cannot be ".", ".." or contain a path separator`);
      }
      if (byName.has(name)) throw new Error(`${label}: duplicate routine name "${name}" — kept the first`);
      byName.set(name, {
        name,
        prompt: r.prompt,
        ...(r.cron !== undefined ? { cron: r.cron } : {}),
        ...(r.tz !== undefined ? { tz: r.tz } : {}),
      });
      secrets.set(name, declaration.secrets);
    } catch (error) {
      failures.push({ label, file, message: (error as Error).message });
    }
  }
  return { routines: [...byName.values()], secrets, failures };
}
