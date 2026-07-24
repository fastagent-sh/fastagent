/**
 * Durable scheduler state for a SINGLE-PROCESS deployment, under `<stateRoot>/schedule/`. Small JSON
 * files, atomic (tmp+rename) so a crash never leaves a torn file:
 *  - `fires.json` — schedule name → last-fired ISO (durability for the cron catch-up-once);
 *  - `wakeups.json` — the agent's pending self-scheduled one-shot wake-ups (wakeups.ts).
 * The root state dir already self-ignores (`.state/.gitignore`), so no per-dir .gitignore.
 *
 * ponytail: this atomic read/write duplicates channels/telegram/state.ts's primitive (both KB-JSON
 * tmp+rename). Extract a neutral src/state.ts and have both import it when a third consumer appears.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { log } from "../log.ts";

/** Path of a JSON file under `<stateRoot>/schedule/`. */
export function scheduleFile(stateRoot: string, name: string): string {
  return join(stateRoot, "schedule", `${name}.json`);
}

/**
 * Read a JSON state file. Missing is normal (first run → undefined); a corrupt file degrades visibly
 * (warn + undefined) — schedule state is recoverable, not worth refusing to boot over; an unreadable
 * file (permissions/IO) throws — a real environment fault the operator must fix, not hide behind empty
 * state. The caller owns shape validation (an IO boundary).
 */
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
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
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
