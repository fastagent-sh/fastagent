/**
 * Generic ESM module discovery + loading for the agent's code-input dirs (`tools/`, `channels/`, `routines/`,
 * config).
 */
import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
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
 * What a running process can do with a change to this file, as code a tool may import:
 * - `"fresh"`: TypeScript, which jiti always transpiles, so {@link importFresh} re-reads it.
 * - `"restart"`: a format jiti hands to Node's own loaders — an ESM `.mjs`/`.js` to `import()`, a `.cjs`/`.json` to
 *   `require` — whose caches keep the file as first loaded (measured: a `.js` helper edited from 1 to 2 still reads
 *   1). pi's `/reload` has the same line for extensions.
 * - `undefined`: not code at all (`README.md`, an editor's `.swp`, `.DS_Store`) — nothing loads it, so a change to it
 *   changes nothing and is not one to announce.
 */
export function reloadKind(file: string): "fresh" | "restart" | undefined {
  if (/\.[cm]?tsx?$/.test(file)) return "fresh";
  if (/\.(m?js|cjs|json)$/.test(file)) return "restart";
  return undefined;
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

/** Every file under a code directory, at any depth, with its size and modification time ({@link codeStamp}). */
export type CodeStamp = ReadonlyMap<string, string>;

/**
 * What a code directory the agent rewrites (`tools/`, `routines/`) looks like on disk. Asked per invoke or per poll,
 * so it stats and never imports; a change here is what makes the next read load the directory again. Helpers
 * imported from OUTSIDE the directory are not in it — they reload with the file that imports them, when it changes.
 */
export async function codeStamp(dir: string): Promise<CodeStamp> {
  let files: string[];
  try {
    files = (await readdir(dir, { recursive: true, withFileTypes: true }))
      // Only what could be imported: a README or an editor's swap file coming and going is not a change.
      .filter((entry) => entry.isFile() && reloadKind(entry.name) !== undefined)
      .map((entry) => join(entry.parentPath, entry.name))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
  const stamps = await Promise.all(
    files.map(async (file) => {
      try {
        const { size, mtimeMs } = await stat(file);
        return [file, `${size}\u0000${mtimeMs}`] as const;
      } catch (error) {
        // Removed between the listing and the stat — a turn running `rm` or `git checkout` beside this one, or an
        // editor's temp file. Gone is a state of the directory, not a fault; the next stamp sees it. Not reproduced in
        // a test: the window is two awaits wide and there is no seam to hold it open.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    }),
  );
  return new Map(stamps.filter((stamp) => stamp !== undefined));
}

/** The files added, removed or rewritten between two stamps. */
function changedFiles(before: CodeStamp, after: CodeStamp): string[] {
  const changed = [...after].filter(([file, stamp]) => before.get(file) !== stamp).map(([file]) => file);
  return [...changed, ...[...before.keys()].filter((file) => !after.has(file))];
}

/**
 * What each live code directory's last reload could NOT load, by agent dir, then by directory (`tools/`,
 * `routines/`). The ONE way a failure reaches the agent: the pi prompt reads it every turn (create.ts), whichever
 * directory failed and whichever layer loaded it — `routines/` is loaded by the neutral service, far from the prompt.
 * Entries are disk-derived and cleared by the reload that succeeds.
 */
const failures = new Map<string, Map<string, string>>();

/** The live directories of this agent whose last reload failed, and why. */
export function liveCodeFailures(agentDir: string): { label: string; failure: string }[] {
  return [...(failures.get(resolve(agentDir)) ?? [])].map(([label, failure]) => ({ label, failure }));
}

/**
 * A code directory the agent rewrites while it runs (`tools/`, `routines/`), LIVE: each read gets it as it is on
 * disk. Loaded again only when {@link codeStamp} moved; what a caller already holds is unaffected.
 *
 * A reload that fails KEEPS THE LAST VALUE THAT LOADED and says why: in the log once per state of the directory, and
 * in {@link liveCodeFailures} for as long as that state lasts — the agent that broke the file is the one placed to
 * fix it, and a tool or a routine that is simply absent tells it nothing. Boot refuses the same failure, but here
 * refusing would fail every read after it — including the turn the agent needs to repair what it just broke. All or
 * nothing: a half-applied directory is a set nobody wrote.
 *
 * Only TypeScript reloads ({@link reloadKind}); a change to a file Node caches is said to need a restart, and when
 * that is all that changed nothing is reloaded — logging "reloaded" over a file Node still has cached is the one
 * outcome worse than not reloading.
 */
export function liveCode<T>(options: {
  /** The directory, and the agent dir its files are named relative to in the log. */
  dir: string;
  agentDir: string;
  boot: { stamp: CodeStamp; value: T };
  /** Load the directory, or throw why it cannot be; given what was held, for a caller that reports the difference. */
  load: (previous: T) => Promise<T>;
}): () => Promise<T> {
  const { dir, agentDir, load } = options;
  const label = `${relative(agentDir, dir)}/`;
  const failed = failures.get(resolve(agentDir)) ?? new Map<string, string>();
  failures.set(resolve(agentDir), failed);
  // The boot value LOADED, so whatever an earlier reader of this directory recorded — a service an embedder closed
  // and mounted again — is not this one's state.
  failed.delete(label);
  let current = options.boot;
  let reloading: Promise<void> | undefined;
  return async () => {
    const stamp = await codeStamp(dir);
    const changed = changedFiles(current.stamp, stamp);
    if (changed.length === 0) return current.value;
    const cached = changed.filter((file) => reloadKind(file) === "restart");
    if (cached.length > 0) {
      log.warn(
        `[fastagent] ${cached.map((file) => relative(agentDir, file)).join(", ")} changed — only TypeScript in ` +
          `${label} reloads while the agent runs, so restart to load this change`,
      );
    }
    if (cached.length === changed.length) {
      current = { ...current, stamp };
      return current.value;
    }
    // Concurrent reads share one reload; whichever stamp it read, the next read compares again.
    reloading ??= (async () => {
      try {
        const value = await load(current.value);
        current = { stamp, value };
        failed.delete(label);
        log.info(`[fastagent] ${label} changed — reloaded`);
      } catch (error) {
        const failure = (error as Error).message;
        current = { stamp, value: current.value };
        failed.set(label, failure);
        log.warn(
          `[fastagent] ${label} changed but could not be loaded, so the previous version stays in use until the ` +
            `next change under ${label} loads: ${failure}`,
        );
      } finally {
        reloading = undefined;
      }
    })();
    await reloading;
    return current.value;
  };
}
