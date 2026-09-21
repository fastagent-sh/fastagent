/**
 * Routine discovery: an agent declares its named units of work by dropping files in `routines/`, mirroring
 * `tools/` and `channels/`.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { type ModuleLoadFailure, isModuleFile, loadModuleDir } from "../loader.ts";
import { type DeclaredSecret, readSecretDeclaration } from "../declared-secrets.ts";
import { assertInsideAgentDir } from "../paths.ts";
import { log } from "../log.ts";
import { cronError } from "./cron.ts";
import { isSafeScheduleName } from "./state.ts";
import type { LoadedRoutine, Routine } from "./routine.ts";

/**
 * Say something about a `schedules/` directory, which is what `routines/` used to be called.
 *
 * WITHOUT THIS THE UPGRADE IS SILENT AND THE CRON JUST STOPS. Nothing reads `schedules/` any more —
 * `loadRoutines`, the dev watcher's code inputs and the nested-scaffold surface all name `routines/` — so an
 * agent that still has the old directory boots clean, reports `routines: (none)`, and never fires. That is the
 * one failure shape this repo refuses to ship: an absent capability announced as a ready service.
 *
 * A WARNING, NOT A REFUSAL. In a flat layout the agent dir IS the repo, so an unrelated `schedules/` of the
 * author's own is possible, and a hard stop on a name we used to own would be us breaking their project. The
 * warning names the rename and costs nothing when it is wrong.
 */
async function warnAboutStaleSchedulesDir(dir: string): Promise<void> {
  const stale = join(dir, "schedules");
  let entries: string[];
  try {
    entries = await readdir(stale);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ENOENT/ENOTDIR is the ordinary case — there is no such directory, which is what an upgraded agent looks
    // like. Anything else (EACCES on a directory we can see) is rethrown with the path: the caller is about to
    // read the agent dir anyway, so a permission fault there is not something to swallow here.
    if (code === "ENOENT" || code === "ENOTDIR" || code === "not_found") return;
    throw new Error(`cannot read ${stale}: ${(error as Error).message}`, { cause: error });
  }
  const files = entries.filter(isModuleFile);
  if (files.length === 0) return;
  log.warn(
    `[fastagent] ${dir}/schedules/ holds ${files.length} code input(s) that NOTHING loads — the directory is ` +
      `now \`routines/\` (and \`defineSchedule\` is \`defineRoutine\`). Rename it, or those time triggers never fire: ` +
      files.join(", "),
  );
}

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
  await warnAboutStaleSchedulesDir(dir);
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
