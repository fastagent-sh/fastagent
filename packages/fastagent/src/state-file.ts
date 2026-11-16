/**
 * A Caller's durable state under the state root (the schedules', in `schedule/`), with no cross-instance locking: one
 * process owns an instance's state root.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "./atomic-write.ts";
import { log } from "./log.ts";

/** Create a Caller's state home: the one shared spelling of it. */
export function ensureStateHome(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/** Returns `unknown` on purpose — no generic pretending otherwise. */
export function loadStateFile(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; // first run — normal
    // Permissions/IO: an environment error — fail the boot loudly rather than run on invisible state.
    throw new Error(`state file ${path} is unreadable — fix permissions/disk and restart: ${String(e)}`, {
      cause: e,
    });
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    log.warn(`[fastagent] corrupt state file ${path} — starting empty: ${String(e)}`);
    return undefined;
  }
}

export function saveStateFile(path: string, value: unknown): void {
  writeFileAtomic(path, JSON.stringify(value));
}
