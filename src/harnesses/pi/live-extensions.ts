/**
 * Extensions are LIVE: what `extensions/` holds now is what the next load runs, for every reader alike (a session, the
 * `/` menu, the model catalog, `chat`).
 *
 * pi imports each extension through jiti with its module cache off, but keeps the factory in a per-process cache and
 * drops that cache only when a resource loader that has already loaded reloads; `clearExtensionCache` itself is not
 * exported. So the ONE place that knows whether the cached code is current is here: every reader asks
 * {@link LiveExtensions.paths} before it loads, and when anything under `extensions/` changed since the cache was
 * filled, the cache is dropped first. Readers never decide this themselves, so none can load stale code while another
 * loads fresh.
 */
import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DefaultResourceLoader, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";

export interface LiveExtensions {
  /**
   * The extension entry points to load now, with the generation they belong to: it changes whenever the code handed
   * out does, and is what a derived cache (the model catalog) is keyed by. Taken together, so a list read while
   * another reader dropped the cache is never filed under that reader's newer generation. Resolves only once pi's
   * cache holds the code on disk: when it changed, the cache is dropped before this resolves, by one caller while
   * the others wait for it. A failure to drop it rejects (and the next call tries again), never resolves with stale
   * code.
   */
  paths(): Promise<{ paths: readonly string[]; generation: number }>;
}

/** What one agent directory's cached code was loaded from, shared by every reader in the process (pi's cache is). */
interface Tracked {
  /** Undefined before the first load, when there is nothing cached yet. */
  loadedFrom?: string;
  generation: number;
  inFlight?: Promise<void>;
}

/**
 * PER PROCESS, by directory, because pi's cache is per process: two `agentModels` over one directory (a serve and an
 * embedder's `availableModelsFromDir`) must not each believe they are the first to load it, or the second would load
 * the first's stale code without dropping it.
 */
const tracked = new Map<string, Tracked>();

/**
 * Track `<agentDir>/extensions/`. `list` is the one discovery of its entry points; the change check only decides
 * WHEN pi reloads.
 */
export function liveExtensions(agentDir: string, list: () => Promise<readonly string[]>): LiveExtensions {
  const dir = resolve(agentDir);
  const state = tracked.get(dir) ?? { generation: 0 };
  tracked.set(dir, state);

  const current = async (): Promise<void> => {
    const now = await fingerprint(join(dir, "extensions"));
    if (now === state.loadedFrom) return;
    // Something cached is older than the disk (or nothing is cached yet, when there is nothing to drop). The new
    // fingerprint is committed only once the drop has happened: a failed drop leaves the next call to try again.
    if (state.loadedFrom !== undefined) await dropExtensionCache(dir);
    state.loadedFrom = now;
    state.generation++;
  };

  return {
    async paths() {
      // Single-flight: concurrent readers after an edit wait for one drop instead of each loading in between.
      state.inFlight ??= current().finally(() => {
        state.inFlight = undefined;
      });
      await state.inFlight;
      const generation = state.generation;
      return { paths: await list(), generation };
    },
  };
}

/**
 * Drop pi's per-process extension cache, through the one public way it has: a loader's second `reload()` clears it.
 * This loader loads nothing (no extensions, skills, prompts, themes or context files, and no settings of the machine),
 * so the drop costs two empty loads.
 */
async function dropExtensionCache(cwd: string): Promise<void> {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  await loader.reload();
}

/**
 * Every file under `dir` as one string that changes when any of them does (path, size, modification time); empty when
 * `dir` does not exist. A file gone between listing and `stat` is simply not there any more: an editor's or an atomic
 * write's rename does that, and it is not a failure.
 *
 * Every reader asks this before it loads, so it skips what can be large and is not the extensions' own code: a
 * `node_modules` (an extension with its own dependencies) and dot directories (`.git`). A dependency upgraded without
 * touching any file outside them (its `package.json` or lockfile) is therefore not seen until the next start.
 */
async function fingerprint(dir: string): Promise<string> {
  const lines: string[] = [];
  const walk = async (at: string, prefix: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(at, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const name = `${prefix}${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name.startsWith(".")) return;
          return walk(join(at, entry.name), `${name}/`);
        }
        try {
          // `stat`, not the entry: a symlink to a file counts as the file it names.
          const info = await stat(join(at, entry.name));
          if (info.isFile()) lines.push(`${name}\t${info.size}\t${info.mtimeMs}`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }),
    );
  };
  await walk(dir, "");
  return lines.sort().join("\n");
}
