/**
 * Schedule discovery (the N axis, clock form): an agent declares its time-triggers by dropping files in `schedules/`,
 * mirroring `tools/` and `channels/`.
 */
import { join } from "node:path";
import { type ModuleLoadFailure, loadModuleDir } from "../loader.ts";
import { type DeclaredSecret, readSecretDeclaration } from "../declared-secrets.ts";
import { assertInsideAgentDir } from "../paths.ts";
import { cronError } from "./cron.ts";
import type { LoadedSchedule, Schedule } from "./schedule.ts";

/**
 * Discover schedules in `<dir>/schedules/`: each file default-exports a `defineSchedule({...})`, named from its
 * filename.
 */
export async function loadSchedules(dir: string): Promise<{
  schedules: LoadedSchedule[];
  /** What each loaded schedule declared it needs, BY SCHEDULE NAME and attributed to its file. Per
   *  schedule because a caller that fires exactly ONE of them (`fastagent fire`) must not be stopped
   *  by a sibling's credential, and because two schedules declaring the same variable would
   *  otherwise blame whichever file was read first. The scheduler flattens it (it runs all of them).
   *  Data, not a check — only a serving path asserts it (src/declared-secrets.ts). */
  secrets: Map<string, DeclaredSecret[]>;
  failures: ModuleLoadFailure[];
}> {
  await assertInsideAgentDir(dir, "schedules");
  const { modules, failures } = await loadModuleDir(join(dir, "schedules"));
  const byName = new Map<string, LoadedSchedule>();
  const secrets = new Map<string, DeclaredSecret[]>();
  for (const { name, label, file, mod } of modules) {
    try {
      const s = mod.default as Partial<Schedule> | undefined;
      if (!s || typeof s.cron !== "string" || typeof s.prompt !== "string") {
        throw new Error(`${label} must default-export defineSchedule({ cron, prompt })`);
      }
      const declaration = readSecretDeclaration(s, label);
      if (declaration.error !== undefined) throw new Error(declaration.error);
      const err = cronError(s.cron, s.tz);
      if (err) throw new Error(`${label}: invalid cron/tz — ${err}`);
      // "wake" is reserved: the run audit records self-scheduled wake-ups under that name, so a schedule named wake
      // would make `schedule history wake` an unreadable mix of two different things.
      if (name === "wake")
        throw new Error(`${label}: "wake" is a reserved schedule name (the self-scheduling audit uses it)`);
      if (byName.has(name)) throw new Error(`${label}: duplicate schedule name "${name}" — kept the first`);
      byName.set(name, { name, cron: s.cron, tz: s.tz, prompt: s.prompt });
      secrets.set(name, declaration.secrets);
    } catch (error) {
      failures.push({ label, file, message: (error as Error).message });
    }
  }
  return { schedules: [...byName.values()], secrets, failures };
}
