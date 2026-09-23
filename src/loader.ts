/**
 * Generic ESM module discovery + loading for the agent's code-input dirs (`tools/`, `channels/`, `routines/`,
 * config).
 */
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { log } from "./log.ts";

const MODULE_EXTS = new Set([".ts", ".js", ".mjs"]);

/** Whether `name` is an importable agent module (a discovery candidate, not a type declaration). */
/** Does this filename look like a code input? Exported so a caller can ask about a directory it does NOT load. */
export function isModuleFile(name: string): boolean {
  return MODULE_EXTS.has(extname(name)) && !name.endsWith(".d.ts");
}

/** The name a module is known by: its basename without the extension. */
function moduleName(fileName: string): string {
  return basename(fileName, extname(fileName));
}

/** One module file a directory declares. */
interface InventoryEntry {
  /** Basename without extension — the authoritative name for tools/channels/schedules. */
  name: string;
  /** "tools/foo.ts"-style label for errors and collisions. */
  label: string;
  file: string;
}

/**
 * WHAT A CODE-INPUT DIRECTORY DECLARES — the single answer to "which files here are modules", without importing any of
 * them. Internal: the loading functions below are its only consumers.
 */
async function moduleInventory(subDir: string): Promise<InventoryEntry[]> {
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

/**
 * THE REFUSAL every path that is about to RUN the agent shares: an enabled file under `tools/`, `channels/` or
 * `routines/` is a declaration, so one that cannot load means the agent is missing something its author said it
 * has. Starting anyway announces a ready service over an absent capability — a schedule that never fires, a tool the
 * model simply never gets — with nothing but one warning to find it by. Every failure is reported before this
 * throws, so a boot fixes all of them at once rather than one per restart.
 *
 * Inspecting a definition (`info`, `fastagent tool`) is NOT this path: it must survive a broken file in order to
 * report it.
 */
export function refuseBrokenDeclarations(failures: readonly ModuleLoadFailure[]): void {
  if (failures.length === 0) return;
  reportModuleLoadFailures(failures);
  // The reasons are repeated from the warnings above because this message is all an embedder catching the rejection
  // has, and all a deployment running at FASTAGENT_LOG_LEVEL=error sees.
  throw new Error(
    `failed to load: ${failures.map((f) => `${f.label} (${f.message})`).join("; ")} — fix it, or rename an ` +
      `intentionally disabled file to *.disabled`,
  );
}

/**
 * Whether {@link importFresh} can re-read this file in a running process: TypeScript, which jiti always transpiles.
 * Every other format it hands to Node's own loaders — an ESM `.mjs`/`.js` to `import()`, a `.cjs`/`.json` to
 * `require` — whose caches keep the file as first loaded (measured: a `.js` helper edited from 1 to 2 still reads 1).
 * pi's `/reload` has the same line for extensions. A change to any other file takes a restart.
 */
export function reloadsLive(file: string): boolean {
  return /\.[cm]?tsx?$/.test(file);
}

/** One module's import: what it exported, or why it could not be imported. */
type Imported = { mod: { default?: unknown } } | { error: unknown };

/**
 * Import modules the agent may REWRITE while this process runs, as they are on disk now — each module and every local
 * file it imports. Node's own `import()` caches by URL, and busting the entry's URL (`?v=2`) re-reads only the entry:
 * a helper it imports stays the old one (measured), a half-swapped module. This is what pi's `/reload` does for
 * extensions. What it does NOT re-evaluate is an installed package — jiti hands those to Node — which is also what
 * keeps a tool's `@fastagent-sh/fastagent` the host's own.
 *
 * ONE evaluation for the whole set: with `moduleCache: false`, jiti gives each top-level import a cache of its own,
 * so importing the files one by one evaluated a helper they share once per file — two connection pools where the
 * author wrote one. The files are imported from inside one evaluated entry instead, which shares one cache, and each
 * is caught there on its own, so one broken file still costs only itself.
 */
async function importFresh(dir: string, files: readonly string[]): Promise<Imported[]> {
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    // No transpile cache written next to a deployed definition.
    fsCache: false,
    // jiti defaults this ON under Bun, where it hands the file to Bun's own `import()` — whose cache returns the
    // module as first loaded, forever (measured). Every reload would then log "reloaded" over the old tools.
    tryNative: false,
  });
  const entry = (await jiti.evalModule(
    `export default async (files) => {
      const out = [];
      for (const file of files) {
        try { out.push({ mod: await import(file) }); } catch (error) { out.push({ error }); }
      }
      return out;
    };`,
    // Never written, and named so it cannot be: jiti keys its cache by this path, so a real `tools/<name>.ts` would
    // be answered with this entry. `ext` makes it transpiled — an `.mjs` name was first tried as a native import.
    { filename: join(dir, "fastagent-load"), ext: ".ts", async: true },
  )) as { default: (files: readonly string[]) => Promise<Imported[]> };
  return entry.default(files);
}

async function importNative(files: readonly string[]): Promise<Imported[]> {
  const out: Imported[] = [];
  for (const file of files) {
    try {
      out.push({ mod: (await import(pathToFileURL(file).href)) as { default?: unknown } });
    } catch (error) {
      out.push({ error });
    }
  }
  return out;
}

/** Import every module the directory declares ({@link moduleInventory}); `fresh` imports through {@link importFresh}. */
export async function loadModuleDir(
  subDir: string,
  options: { fresh?: boolean } = {},
): Promise<{ modules: DiscoveredModule[]; failures: ModuleLoadFailure[] }> {
  const entries = await moduleInventory(subDir);
  const files = entries.map((entry) => entry.file);
  const imported = options.fresh ? await importFresh(subDir, files) : await importNative(files);
  const modules: DiscoveredModule[] = [];
  const failures: ModuleLoadFailure[] = [];
  entries.forEach(({ name, label, file }, index) => {
    const result = imported[index] as Imported;
    if ("mod" in result) {
      modules.push({ name, label, file, mod: result.mod });
      return;
    }
    const error = result.error as NodeJS.ErrnoException;
    failures.push({ label, file, message: `${error.message}${moduleLoadHint(error)}` });
  });
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
