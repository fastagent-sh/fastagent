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
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DefaultResourceLoader, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";

export interface LiveExtensions {
  /**
   * The extension entry points to load now. Resolves only once pi's cache holds the code on disk: when it changed,
   * the cache is dropped before this resolves, by one caller while the others wait for it. A failure to drop it
   * rejects (and the next call tries again), never resolves with stale code.
   */
  paths(): Promise<readonly string[]>;
  /** Changes whenever the code {@link paths} hands out does: what a derived cache (the model catalog) is keyed by. */
  generation(): number;
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
 * Track `<agentDir>/extensions/`. `list` is the one discovery of its entry points (through the definition's
 * `ExecutionEnv`); the change check reads Node's filesystem, since it only decides WHEN pi reloads.
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
      return list();
    },
    generation: () => state.generation,
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
 */
async function fingerprint(dir: string): Promise<string> {
  let names: string[];
  try {
    names = await readdir(dir, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
  const files = await Promise.all(
    names.map(async (name) => {
      const path = join(dir, name);
      try {
        const info = await stat(path);
        return info.isFile() ? `${name}\t${info.size}\t${info.mtimeMs}` : undefined;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    }),
  );
  return files
    .filter((line) => line !== undefined)
    .sort()
    .join("\n");
}
