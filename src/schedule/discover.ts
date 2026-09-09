/**
 * Schedule discovery (the N axis, clock form): an agent declares its time-triggers by dropping files in `schedules/`,
 * mirroring `tools/` and `channels/`.
 */
import { join } from "node:path";
import { type ModuleLoadFailure, loadModuleDir, moduleInventory } from "../loader.ts";
import { assertInsideAgentDir } from "../paths.ts";
import { cronError } from "./cron.ts";
import type { LoadedSchedule, Schedule } from "./schedule.ts";

/** Schedule file basenames under `<dir>/schedules/`. */
export async function discoverScheduleFiles(dir: string): Promise<string[]> {
  await assertInsideAgentDir(dir, "schedules");
  const entries = await moduleInventory(join(dir, "schedules"));
  return entries.map((entry) => entry.name);
}

/**
 * Discover schedules in `<dir>/schedules/`: each file default-exports a `defineSchedule({...})`, named from its
 * filename.
 */
export async function loadSchedules(
  dir: string,
): Promise<{ schedules: LoadedSchedule[]; failures: ModuleLoadFailure[] }> {
  await assertInsideAgentDir(dir, "schedules");
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
      // "wake" is reserved: the run audit records self-scheduled wake-ups under that name, so a schedule named wake
      // would make `schedule history wake` an unreadable mix of two different things.
      if (name === "wake")
        throw new Error(`${label}: "wake" is a reserved schedule name (the self-scheduling audit uses it)`);
      if (byName.has(name)) throw new Error(`${label}: duplicate schedule name "${name}" — kept the first`);
      byName.set(name, { name, cron: s.cron, tz: s.tz, prompt: s.prompt });
    } catch (error) {
      failures.push({ label, file, message: (error as Error).message });
    }
  }
  return { schedules: [...byName.values()], failures };
}
