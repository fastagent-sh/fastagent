/**
 * Schedule discovery (the N axis, clock form): a workspace declares its time-triggers by dropping files
 * in `schedules/`, mirroring `tools/` and `channels/`. Each file default-exports `defineSchedule({...})`,
 * named from its filename. This is the FILE producer of scheduled invocations (the author's, declarative,
 * git-tracked, deploy-guaranteed); the agent's `wake` tool will be the second producer (Phase 4).
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { type ModuleLoadFailure, isModuleFile, loadModuleDir } from "../engines/pi/loader.ts";
import { assertInsideWorkspace } from "../workspace.ts";
import { cronError } from "./cron.ts";
import type { LoadedSchedule, Schedule } from "./schedule.ts";

/** Schedule file basenames under `<dir>/schedules/` — the authoring view (`fastagent info`), listed
 *  WITHOUT importing (like {@link import("../engines/pi/channel.ts").discoverChannelFiles}). */
export async function discoverScheduleFiles(dir: string): Promise<string[]> {
  await assertInsideWorkspace(dir, "schedules");
  let names: string[];
  try {
    names = await readdir(join(dir, "schedules"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names
    .filter(isModuleFile)
    .map((n) => n.replace(/\.(ts|js|mjs)$/, ""))
    .sort();
}

/**
 * Discover schedules in `<dir>/schedules/`: each file default-exports a `defineSchedule({...})`, named
 * from its filename. A file broken for ANY reason — a failed import, not a schedule (no cron/prompt), or
 * an invalid cron/tz — is ISOLATED into `failures` (skipped + reported, never a crash-loop, G2), the same
 * way `loadTools`/`loadChannels` isolate theirs. A duplicate name (foo.ts + foo.js) keeps the first and
 * reports the rest.
 */
export async function loadSchedules(
  dir: string,
): Promise<{ schedules: LoadedSchedule[]; failures: ModuleLoadFailure[] }> {
  await assertInsideWorkspace(dir, "schedules");
  const { modules, failures } = await loadModuleDir(join(dir, "schedules"));
  const byName = new Map<string, LoadedSchedule>();
  for (const { name, label, file, mod } of modules) {
    try {
      const s = mod.default as Partial<Schedule> | undefined;
      if (!s || typeof s.cron !== "string" || typeof s.prompt !== "string") {
        throw new Error(`${label} must default-export defineSchedule({ cron, prompt })`);
      }
      const err = cronError(s.cron, s.tz);
      if (err) throw new Error(`${label}: invalid cron/tz — ${err}`);
      if (byName.has(name)) throw new Error(`${label}: duplicate schedule name "${name}" — kept the first`);
      byName.set(name, { name, cron: s.cron, tz: s.tz, prompt: s.prompt });
    } catch (error) {
      failures.push({ label, file, message: (error as Error).message });
    }
  }
  return { schedules: [...byName.values()], failures };
}
