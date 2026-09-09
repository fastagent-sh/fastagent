/**
 * Durable channel state for a SINGLE-PROCESS deployment (the supported production shape — no cross-instance locking;
 * two processes must not share a state dir).
 */
import { mkdirSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "../../atomic-write.ts";
import { log } from "../../log.ts";

/** Create the channel's state home — the one shared spelling of it, so no channel invents its own. */
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
    throw new Error(`channel state file ${path} is unreadable — fix permissions/disk and restart: ${String(e)}`, {
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
