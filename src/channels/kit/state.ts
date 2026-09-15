/**
 * Durable channel state, with no cross-instance locking: every file here is keyed by CHANNEL KIND
 * (`<stateRoot>/channels/<kind>/`), so what must not happen is two processes serving the SAME channel — which also
 * means one ingress credential in two places, and no local guard can see that. Two processes serving different
 * channels of one agent never touch the same file (docs/design/core.md, "the shipped file-backed implementations").
 */
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../../atomic-write.ts";
import { log } from "../../log.ts";

/**
 * Create the channel's state home — the one shared spelling of it, so no channel invents its own — and clear the
 * inbound attachments inside it.
 *
 * `files/` is `/tmp`, not storage: every image a chat sends lands there and nothing ever asked for it back, so on a
 * real volume it is unbounded. Clearing at mount gives it the contract `/tmp` has had since V7 — emptied when the
 * machine comes up — which needs no ager, no TTL, and no reference tracking. The cost is named: a session that still
 * points at an attachment from before this process reads ENOENT, exactly as a `/tmp` path from the last boot does.
 *
 * Mount time is the whole point: channels mount once when the service starts, so a one-shot `invoke` running beside a
 * live server never touches these files.
 */
export function ensureStateHome(dir: string): void {
  mkdirSync(dir, { recursive: true });
  // No catch, for the same reason `mkdirSync` has none: a state home this process cannot manage is an environment
  // fault, and starting on it would only move the failure somewhere less legible.
  rmSync(join(dir, "files"), { recursive: true, force: true });
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
