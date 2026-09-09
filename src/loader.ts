/**
 * Generic ESM module discovery + loading for the agent's code-input dirs (`tools/`, `channels/`, `schedules/`,
 * config).
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

/** One module file a directory declares. */
export interface InventoryEntry {
  /** Basename without extension — the authoritative name for tools/channels/schedules. */
  name: string;
  /** "tools/foo.ts"-style label for errors and collisions. */
  label: string;
  file: string;
}

/**
 * WHAT A CODE-INPUT DIRECTORY DECLARES — the single answer to "which files here are modules", without importing any of
 * them.
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

/** An agent module that failed to load, surfaced as data so its caller can report the exact file. */
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

/** Import every module the directory declares ({@link moduleInventory}). */
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
 * A hint for the two common dynamic-import failures — an uninstalled dependency or a non-ESM package — and empty
 * otherwise, so an unrelated error is reported on its own.
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
