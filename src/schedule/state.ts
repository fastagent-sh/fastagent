/** Durable scheduler state for a SINGLE-PROCESS deployment, under `<stateRoot>/schedule/`. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic-write.ts";
import { log } from "../log.ts";

/** Path of a JSON file under `<stateRoot>/schedule/`. */
export function scheduleFile(stateRoot: string, name: string): string {
  return join(stateRoot, "schedule", `${name}.json`);
}

export function readScheduleFile(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`schedule state ${path} is unreadable — fix permissions/disk and restart: ${String(e)}`, {
      cause: e,
    });
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    log.warn(`[schedule] corrupt state file ${path} — ignoring: ${String(e)}`);
    return undefined;
  }
}

export function writeScheduleFile(path: string, value: unknown): void {
  writeFileAtomic(path, JSON.stringify(value));
}

// ── fires.json: schedule name → last-fired ISO (cron catch-up-once durability) ──

/** name → last-fired ISO timestamp. */
export type Fires = Record<string, string>;

export function loadFires(stateRoot: string): Fires {
  const v = readScheduleFile(scheduleFile(stateRoot, "fires"));
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Fires) : {};
}

export function saveFires(stateRoot: string, fires: Fires): void {
  writeScheduleFile(scheduleFile(stateRoot, "fires"), fires);
}
