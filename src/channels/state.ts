/**
 * Durable channel state for a SINGLE-PROCESS deployment (the supported production shape — no
 * cross-instance locking; two processes must not share a state dir). Small JSON files, written
 * atomically (tmp + rename), so a crash leaves the previous version on disk, never a torn file.
 * Writes are synchronous: the files are KB-sized and a write that completes BEFORE the webhook 200
 * is what makes the state actually durable (an ACKed webhook delivery is not redelivered).
 * Channel-neutral: every stateful channel (telegram, lark) derives its home from the ctx state root
 * and persists through these three primitives.
 *
 * Failure split: a CORRUPT file (bad JSON) degrades visibly — log.warn + start empty — because channel
 * state is recoverable context, not worth refusing to boot over. An unreadable file (permissions, IO)
 * is an ENVIRONMENT error the operator must fix: it throws, and construction fails loudly — booting
 * with silently-empty state would hide real data behind a config mistake.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { log } from "../log.ts";

/** Create the state home and self-ignore it (`.gitignore="*"`): its contents (buffers, downloaded
 *  files) can carry chat content and must never be committable. The workspace opener already protects
 *  an in-tree state root; this local guard also covers direct embedders. `wx` never clobbers an
 *  operator's own file. */
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
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
}
