/**
 * Generic ESM module discovery + loading for the agent's code-input dirs (`tools/`, `channels/`,
 * `schedules/`, config). Node stdlib plus the logger — engine-neutral, so it lives at the top level:
 * the schedule discovery (src/schedule/) must not reach into `engines/` for what is plain
 * filesystem/import plumbing.
 */
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { log } from "./log.ts";

const MODULE_EXTS = new Set([".ts", ".js", ".mjs"]);

/** Whether `name` is an importable agent module (a discovery candidate, not a type declaration). */
function isModuleFile(name: string): boolean {
  return MODULE_EXTS.has(extname(name)) && !name.endsWith(".d.ts");
}

/** The name a module is known by: its basename without the extension. */
function moduleName(fileName: string): string {
  return basename(fileName, extname(fileName));
}

/** One module file a directory declares. `name` is what the domain knows it by; nothing is imported
 *  to produce this. */
export interface InventoryEntry {
  /** Basename without extension — the authoritative name for tools/channels/schedules. */
  name: string;
  /** "tools/foo.ts"-style label for errors and collisions. */
  label: string;
  file: string;
}

/**
 * WHAT A CODE-INPUT DIRECTORY DECLARES — the single answer to "which files here are modules",
 * without importing any of them.
 *
 * It exists because four consumers need that answer and only one of them may import: the loader
 * below, `fastagent info`'s channel listing, `--tunnel`'s webhook registration, and the deploy
 * pre-flight's schedule probe. When they each read the directory themselves they disagreed — on
 * what counts as a module file, on how to strip the extension, on which errno means "no such
 * directory" — and a fix had to be applied in four places, which is why the fourth kept being
 * missed. There is one reading now; what to DO with a failure stays with the caller, because that
 * genuinely differs (the loader throws, the tunnel cannot).
 *
 * A missing directory is an empty inventory. Everything else throws, ENOTDIR included: `channels`
 * and `schedules` are named directories, so the path existing as a FILE is a mistake in the agent
 * rather than an agent without one (`service.test.ts` pins that for `schedules`). `paths.ts` folds
 * ENOTDIR into its empty scan for the opposite reason — it asks which children HAPPEN to be agent
 * dirs, where a file simply is not one. `not_found` is a non-Node runtime's ENOENT.
 *
 * SYMLINKS ARE SKIPPED, and that is a boundary rather than an oversight: `assertInsideAgentDir`
 * guards the code-input DIRECTORY against escaping the definition, and nothing guards the entries
 * inside it, so following a link would import from anywhere on the box past the very check meant to
 * prevent it. Do not "fix" this by following them — report them, which this does.
 *
 * The skip is WARNED HERE, not handed back, because "this file is not loadable" holds for all four
 * consumers and only one of them imports — a listing that reports the name it cannot load reads as
 * "I never created it". What to do about a load FAILURE does differ per caller, so that travels as
 * data. One warning per READ, so a command that both lists and loads the same directory (`deploy
 * agentcore` does) says it twice — both readings are true, and remembering what was already said
 * would mean a restart stops mentioning a skip that is still there.
 *
 * A skip is therefore a warning ONLY, unlike a {@link ModuleLoadFailure}: it is absent from `info
 * --json` and `deploy` does not gate on it. That is the deliberate cost of one report for four
 * consumers, three of which list names and have nowhere to put data. To give a machine consumer the
 * skips, return them beside the entries — do not reconstruct them from stderr.
 */
export async function moduleInventory(subDir: string): Promise<InventoryEntry[]> {
  let dirents: Dirent[];
  try {
    dirents = await readdir(subDir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "not_found") return [];
    throw new Error(`cannot read ${subDir}: ${(error as Error).message}`);
  }
  const sub = basename(subDir);
  const entries: InventoryEntry[] = [];
  // Sorted by the NAME a consumer sees, so none of them re-sorts and none can disagree about order.
  // Filename breaks a tie: `foo.js` and `foo.ts` both read as `foo`, and the domain loaders document
  // that the FIRST wins — deciding that here keeps it from depending on readdir's order.
  const byName = (a: Dirent, b: Dirent): number =>
    moduleName(a.name).localeCompare(moduleName(b.name)) || a.name.localeCompare(b.name);
  for (const dirent of dirents.sort(byName)) {
    if (!isModuleFile(dirent.name)) continue;
    const label = `${sub}/${dirent.name}`;
    if (dirent.isFile()) {
      entries.push({ name: moduleName(dirent.name), label, file: join(subDir, dirent.name) });
    } else if (dirent.isSymbolicLink()) {
      log.warn(`[fastagent] ${label} is a symlink — code inputs must be real files inside the agent dir — not loaded`);
    } else if (dirent.isDirectory()) {
      log.warn(`[fastagent] ${label} is a directory, not a file — not loaded`);
    } else {
      log.warn(`[fastagent] ${label} is not a regular file — not loaded`);
    }
  }
  return entries;
}

export interface DiscoveredModule {
  /** Basename without extension — the authoritative name for tools/channels. */
  name: string;
  /** "tools/foo.ts"-style label for errors and collisions. */
  label: string;
  file: string;
  mod: { default?: unknown };
}

/** An agent module that failed to load, surfaced as data so its caller can report the exact file.
 *  `loadModuleDir` fills it for import failures; domain loaders add validation failures. The caller owns
 *  policy: tools/schedules may skip one bad file, while serving treats a broken declared channel as fatal. */
export interface ModuleLoadFailure {
  /** "tools/foo.ts"-style label. */
  label: string;
  file: string;
  /** The failure message (an import error carries {@link moduleLoadHint}). */
  message: string;
}

/** A module the loader skipped, said once, the same way for tools, channels and schedules. */
export function reportModuleLoadFailures(failures: readonly ModuleLoadFailure[]): void {
  for (const f of failures) log.warn(`[fastagent] ${f.label} failed to load, skipping it — ${f.message}`);
}

/**
 * Import every module the directory declares ({@link moduleInventory}). A file that fails to IMPORT
 * is collected into `failures` (with {@link moduleLoadHint}) rather than thrown, so the caller can
 * report every bad file and apply domain policy; `loadTools`/`loadChannels` add validation failures
 * the same way. Entries the inventory SKIPPED are already reported by it, for every consumer.
 */
export async function loadModuleDir(
  subDir: string,
): Promise<{ modules: DiscoveredModule[]; failures: ModuleLoadFailure[] }> {
  const entries = await moduleInventory(subDir);
  const modules: DiscoveredModule[] = [];
  const failures: ModuleLoadFailure[] = [];
  for (const { name, label, file } of entries) {
    try {
      const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
      modules.push({ name, label, file, mod });
    } catch (error) {
      failures.push({
        label,
        file,
        message: `${(error as Error).message}${moduleLoadHint(error as NodeJS.ErrnoException)}`,
      });
    }
  }
  return { modules, failures };
}

/**
 * A hint for the two common dynamic-import failures — an uninstalled dependency or a non-ESM
 * package — and empty otherwise, so an unrelated error is reported on its own.
 */
export function moduleLoadHint(error: NodeJS.ErrnoException): string {
  if (error.code === "ERR_MODULE_NOT_FOUND" || /Cannot find (package|module)/.test(error.message)) {
    return "\n  (a dependency is not installed — run `npm install` in the agent dir)";
  }
  if (/import statement outside a module|Unexpected token 'export'|ERR_REQUIRE_ESM/.test(error.message)) {
    return '\n  (the agent dir must be ESM — set "type": "module" in package.json)';
  }
  return "";
}
