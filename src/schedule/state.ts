/**
 * Durable scheduler state for a SINGLE-PROCESS deployment: `<stateRoot>/schedule/fires.json` maps a
 * schedule name to the ISO time it last fired. A fire missed while the process was down is caught up
 * ONCE on the next start (overdue → fire, then advance) — not per-slot. Small JSON, atomic (tmp+rename)
 * so a crash never leaves a torn file. The root state dir already self-ignores (`.fastagent/.gitignore`),
 * and fires.json holds only names + timestamps (no chat content), so no per-dir .gitignore is needed.
 *
 * ponytail: this atomic read/write duplicates channels/telegram/state.ts's primitive (both are KB-JSON
 * tmp+rename). Extract a neutral src/state.ts and have both import it when a third consumer appears.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { log } from "../log.ts";

/** name → last-fired ISO timestamp. */
export type Fires = Record<string, string>;

function firesPath(stateRoot: string): string {
  return join(stateRoot, "schedule", "fires.json");
}

/** Load the fire history. Missing is normal (first run → empty); a corrupt file degrades visibly (warn +
 *  empty, so at most a duplicate catch-up); an unreadable file (permissions/IO) throws — a real
 *  environment fault the operator must fix, not something to hide behind silently-empty state. */
export function loadFires(stateRoot: string): Fires {
  const path = firesPath(stateRoot);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`schedule state ${path} is unreadable — fix permissions/disk and restart: ${String(e)}`, {
      cause: e,
    });
  }
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Fires) : {};
  } catch (e) {
    log.warn(`[schedule] corrupt state file ${path} — starting with no fire history: ${String(e)}`);
    return {};
  }
}

export function saveFires(stateRoot: string, fires: Fires): void {
  const path = firesPath(stateRoot);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(fires));
  renameSync(tmp, path);
}
