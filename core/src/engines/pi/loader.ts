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

/**
 * Import every module file in `subDir`, sorted by name. Missing dir returns none.
 * A failed import names the file and appends {@link moduleLoadHint}.
 */
export async function loadModuleDir(subDir: string): Promise<DiscoveredModule[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(subDir, { withFileTypes: true });
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    if (e.code === "ENOENT" || e.code === "not_found") return [];
    throw new Error(`cannot read ${subDir}: ${(error as Error).message}`);
  }
  const sub = basename(subDir);
  const out: DiscoveredModule[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !isModuleFile(entry.name)) continue;
    const file = join(subDir, entry.name);
    const label = `${sub}/${entry.name}`;
    let mod: { default?: unknown };
    try {
      mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
    } catch (error) {
      throw new Error(
        `cannot load ${label}: ${(error as Error).message}${moduleLoadHint(error as NodeJS.ErrnoException)}`,
      );
    }
    out.push({ name: basename(entry.name, extname(entry.name)), label, file, mod });
  }
  return out;
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
