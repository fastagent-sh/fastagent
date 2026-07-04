/**
 * Durable channel state for a SINGLE-PROCESS deployment (the supported production shape — no
 * cross-instance locking; two processes must not share a state dir). Small JSON files, written
 * atomically (tmp + rename), so a crash leaves the previous version on disk, never a torn file.
 * Writes are synchronous: the files are KB-sized and a write that completes BEFORE the webhook 200
 * is what makes the state actually durable (an ACKed update is never redelivered by Telegram).
 *
 * Failure split: a CORRUPT file (bad JSON) degrades visibly — log.warn + start empty — because channel
 * state is recoverable context, not worth refusing to boot over. An unreadable file (permissions, IO)
 * is an ENVIRONMENT error the operator must fix: it throws, and construction fails loudly — booting
 * with silently-empty state would hide real data behind a config mistake.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { log } from "../../log.ts";

/** Create the state home and self-ignore it (`.gitignore="*"`): its contents (buffers, downloaded
 *  files) can carry chat content and must never be committable. Owned by the channel — the
 *  engine's `.fastagent`-level self-ignore fires only for the paths IT is told about (sessions/auth),
 *  and a channel cannot reach that guard across the layer boundary. `wx`: never clobber an operator's
 *  own file. */
export function ensureStateHome(dir: string): void {
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(join(dir, ".gitignore"), "*\n", { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
}

/** Returns `unknown` on purpose — no generic pretending otherwise: the file is an IO boundary, and the
 *  caller owns shape validation (a `<T>` here would be an unchecked cast wearing a type). */
export function loadStateFile(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; // first run — normal
    // Permissions/IO: an environment error — fail the boot loudly rather than run on invisible state.
    throw new Error(`telegram state file ${path} is unreadable — fix permissions/disk and restart: ${String(e)}`, {
      cause: e,
    });
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    log.warn(`[telegram] corrupt state file ${path} — starting empty: ${String(e)}`);
    return undefined;
  }
}

export function saveStateFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
}
