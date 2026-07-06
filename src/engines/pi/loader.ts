import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";

const MODULE_EXTS = new Set([".ts", ".js", ".mjs"]);

/** Whether `name` is an importable workspace module (a discovery candidate, not a type declaration). */
export function isModuleFile(name: string): boolean {
  return MODULE_EXTS.has(extname(name)) && !name.endsWith(".d.ts");
}

export interface DiscoveredModule {
  /** Basename without extension — the authoritative name for tools/channels. */
  name: string;
  /** "tools/foo.ts"-style label for errors and collisions. */
  label: string;
  file: string;
  mod: { default?: unknown };
}

/** A `tools/`/`channels/` file that failed to LOAD, for any reason. Surfaced as DATA (like skill
 *  diagnostics), never thrown: one bad file must not crash `start`, so the caller reports it and serves
 *  the rest. loadModuleDir fills it for IMPORT failures; loadTools/loadChannels add the ones they detect
 *  (not a tool / not a channel, a factory that throws when called, malformed routes). */
export interface ModuleLoadFailure {
  /** "tools/foo.ts"-style label. */
  label: string;
  file: string;
  /** The failure message (an import error carries {@link moduleLoadHint}). */
  message: string;
}

/**
 * Import every module file in `subDir`, sorted by name. Missing dir returns none. A file that fails to
 * IMPORT is ISOLATED — collected into `failures` (with {@link moduleLoadHint}) and skipped, not thrown —
 * so one bad import can't crash the load; the caller (loadTools/loadChannels) isolates its own per-file
 * failures the same way. (A missing DIRECTORY still returns empty; an unreadable directory still throws
 * — that's not a per-file problem.)
 */
export async function loadModuleDir(
  subDir: string,
): Promise<{ modules: DiscoveredModule[]; failures: ModuleLoadFailure[] }> {
  let entries: Dirent[];
  try {
    entries = await readdir(subDir, { withFileTypes: true });
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    if (e.code === "ENOENT" || e.code === "not_found") return { modules: [], failures: [] };
    throw new Error(`cannot read ${subDir}: ${(error as Error).message}`);
  }
  const sub = basename(subDir);
  const modules: DiscoveredModule[] = [];
  const failures: ModuleLoadFailure[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !isModuleFile(entry.name)) continue;
    const file = join(subDir, entry.name);
    const label = `${sub}/${entry.name}`;
    try {
      const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
      modules.push({ name: basename(entry.name, extname(entry.name)), label, file, mod });
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
    return "\n  (a dependency is not installed — run `npm install` in the workspace)";
  }
  if (/import statement outside a module|Unexpected token 'export'|ERR_REQUIRE_ESM/.test(error.message)) {
    return '\n  (this workspace must be ESM — set "type": "module" in package.json)';
  }
  return "";
}
