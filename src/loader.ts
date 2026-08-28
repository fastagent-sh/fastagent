/**
 * Generic ESM module discovery + loading for the agent's code-input dirs (`tools/`, `channels/`,
 * `schedules/`, config). Pure node stdlib — engine-neutral, so it lives at the top level: the schedule
 * discovery (src/schedule/) must not reach into `engines/` for what is plain filesystem/import plumbing.
 */
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { log } from "./log.ts";

const MODULE_EXTS = new Set([".ts", ".js", ".mjs"]);

/** Whether `name` is an importable agent module (a discovery candidate, not a type declaration). */
export function isModuleFile(name: string): boolean {
  return MODULE_EXTS.has(extname(name)) && !name.endsWith(".d.ts");
}

/**
 * Whether a directory entry IS one — the name test plus `isFile()`, which travel together: a
 * DIRECTORY called `telegram.ts` passes the name alone, and every reader of `channels/` has to
 * reach the same verdict or they disagree about what the deployment serves (the loader would skip
 * it, `info` would list it, `--tunnel` would register a webhook for it).
 *
 * `isFile()` is false for a SYMLINK, and that is load-bearing rather than incidental:
 * `assertInsideAgentDir` guards the code-input DIRECTORY (`channels`, `tools`, `skills`) against
 * escaping the definition, and nothing guards the entries inside it. A symlinked
 * `channels/telegram.ts` would import code from anywhere on the box, past the containment check
 * that exists to prevent exactly that. Do not "fix" this by following links — skipping is the
 * boundary; {@link describeSkipped} is what keeps it from being silent.
 */
export function isModuleEntry(entry: Dirent): boolean {
  return entry.isFile() && isModuleFile(entry.name);
}

/** Why a module-looking entry was skipped, or undefined when it was not one to begin with. An
 *  author who names a file like a channel and gets nothing needs the reason at the moment it is
 *  ignored — the alternative is a channel that silently does not exist. */
function describeSkipped(entry: Dirent): string | undefined {
  if (isModuleEntry(entry) || !isModuleFile(entry.name)) return undefined;
  if (entry.isSymbolicLink()) {
    return "a symlink — code inputs must be real files inside the agent dir (a link could import from anywhere)";
  }
  return entry.isDirectory() ? "a directory, not a file" : "not a regular file";
}

/** The name a discovered module is known by: the basename without its extension. Derived from the
 *  filename rather than a second copy of {@link MODULE_EXTS} as a regex. */
export function moduleName(fileName: string): string {
  return basename(fileName, extname(fileName));
}

/**
 * Whether a read failure means "there is no such directory" — the ordinary case for an agent that
 * ships no `channels/`. Every reader agrees on THIS half; what to do with everything else is theirs
 * (the loader and `info` throw, the tunnel warns — it is void-called, so a throw takes the serve
 * down).
 *
 * ENOTDIR is deliberately NOT here. `channels`/`schedules` are named directories; the path existing
 * as a FILE is a mistake in the agent, not an agent without one, and `service.test.ts` pins that a
 * `schedules` file must reject rather than serve as if nothing was declared. (`paths.ts` folds
 * ENOTDIR into its empty scan for the opposite reason: it is asking which children happen to be
 * agent dirs, where a file is simply not one.) `not_found` is a non-Node runtime's ENOENT.
 */
export function isMissingDir(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "not_found";
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

/**
 * Import every module file in `subDir`, sorted by name. Missing dir returns none. A file that fails to
 * IMPORT is collected into `failures` (with {@link moduleLoadHint}) rather than thrown, so the caller can
 * report every bad file and apply domain policy; `loadTools`/`loadChannels` add validation failures the
 * same way. (A missing DIRECTORY still returns empty; an unreadable directory still throws
 * — that's not a per-file problem.)
 */
export async function loadModuleDir(
  subDir: string,
): Promise<{ modules: DiscoveredModule[]; failures: ModuleLoadFailure[] }> {
  let entries: Dirent[];
  try {
    entries = await readdir(subDir, { withFileTypes: true });
  } catch (error) {
    if (isMissingDir(error)) return { modules: [], failures: [] };
    throw new Error(`cannot read ${subDir}: ${(error as Error).message}`);
  }
  const sub = basename(subDir);
  const modules: DiscoveredModule[] = [];
  const failures: ModuleLoadFailure[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!isModuleEntry(entry)) {
      const why = describeSkipped(entry);
      if (why) log.warn(`[fastagent] ${sub}/${entry.name} is ${why} — not loaded`);
      continue;
    }
    const file = join(subDir, entry.name);
    const label = `${sub}/${entry.name}`;
    try {
      const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
      modules.push({ name: moduleName(entry.name), label, file, mod });
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
