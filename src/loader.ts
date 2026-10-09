/**
 * Generic ESM module discovery + loading for the agent's code-input dirs (`tools/`, `channels/`,
 * config).
 */
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { log } from "./log.ts";

const MODULE_EXTS = new Set([".ts", ".js", ".mjs"]);

/** Whether `name` is an importable agent module (a discovery candidate, not a type declaration). */
function isModuleFile(name: string): boolean {
  return MODULE_EXTS.has(extname(name)) && !name.endsWith(".d.ts");
}

/** A test file (`*.test.*`, `*.spec.*`), which a module tree holds beside the code it tests and never loads. */
function isTestFile(name: string): boolean {
  return /\.(test|spec)\.[^.]+$/.test(name);
}

/** The name a module is known by: its basename without the extension. */
function moduleName(fileName: string): string {
  return basename(fileName, extname(fileName));
}

/** One module file a directory declares. */
interface InventoryEntry {
  /** Basename without extension — the authoritative name for channels, and a tool's name when it declares none. */
  name: string;
  /** "tools/foo.ts"-style label for errors and collisions: the path below the agent directory. */
  label: string;
  file: string;
  /** Below a folder of the directory rather than directly in it (a tree only). */
  nested: boolean;
}

/**
 * WHAT A CODE-INPUT DIRECTORY DECLARES — the single answer to "which files here are modules", without importing any of
 * them. Internal: the loading functions below are its only consumers.
 *
 * Flat (`channels/`): the modules directly in the directory. A tree (`tools/`): the modules at any depth, where folders
 * only organize, without tests (`*.test.*`, `*.spec.*`) and without `node_modules` or a dot-folder, which hold no
 * authored module.
 */
async function moduleInventory(subDir: string, shape: "flat" | "tree"): Promise<InventoryEntry[]> {
  const root = join(subDir, "..");
  const entries: InventoryEntry[] = [];
  const walk = async (dir: string, nested: boolean): Promise<void> => {
    let dirents: Dirent[];
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!nested && (code === "ENOENT" || code === "not_found")) return;
      throw new Error(`cannot read ${dir}: ${(error as Error).message}`);
    }
    // Sorted by the NAME a consumer sees, so none of them re-sorts and none can disagree about order.
    const byName = (a: Dirent, b: Dirent): number =>
      moduleName(a.name).localeCompare(moduleName(b.name)) || a.name.localeCompare(b.name);
    for (const dirent of dirents.sort(byName)) {
      const label = relative(root, join(dir, dirent.name)).split(sep).join("/");
      if (shape === "tree" && dirent.isDirectory()) {
        if (dirent.name === "node_modules" || dirent.name.startsWith(".")) continue;
        await walk(join(dir, dirent.name), true);
        continue;
      }
      if (!isModuleFile(dirent.name) || (shape === "tree" && isTestFile(dirent.name))) continue;
      if (dirent.isFile()) {
        entries.push({ name: moduleName(dirent.name), label, file: join(dir, dirent.name), nested });
      } else if (dirent.isSymbolicLink()) {
        log.warn(
          `[fastagent] ${label} is a symlink — code inputs must be real files inside the agent dir — not loaded`,
        );
      } else if (dirent.isDirectory()) {
        log.warn(`[fastagent] ${label} is a directory, not a file — not loaded`);
      } else {
        log.warn(`[fastagent] ${label} is not a regular file — not loaded`);
      }
    }
  };
  await walk(subDir, false);
  return entries;
}

export interface DiscoveredModule {
  /** Basename without extension — the authoritative name for channels, and a tool's name when it declares none. */
  name: string;
  /** "tools/foo.ts"-style label for errors and collisions. */
  label: string;
  file: string;
  /** Below a folder of the directory (a tree only). */
  nested: boolean;
  mod: Record<string, unknown> & { default?: unknown };
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
 * THE REFUSAL every path that is about to RUN the agent shares: an enabled file under `tools/` or `channels/` is a
 * declaration, so one that cannot load means the agent is missing something its author said it
 * has. Starting anyway announces a ready service over an absent capability — a channel that never answers, a tool the
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

/** Import every module the directory declares ({@link moduleInventory}): directly in it, or at any depth. */
export async function loadModuleDir(
  subDir: string,
  shape: "flat" | "tree" = "flat",
): Promise<{ modules: DiscoveredModule[]; failures: ModuleLoadFailure[] }> {
  const entries = await moduleInventory(subDir, shape);
  const modules: DiscoveredModule[] = [];
  const failures: ModuleLoadFailure[] = [];
  for (const { name, label, file, nested } of entries) {
    try {
      const mod = (await import(pathToFileURL(file).href)) as DiscoveredModule["mod"];
      modules.push({ name, label, file, nested, mod });
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
