/**
 * One spelling of "a reader sees the whole file or none of it", after five copies of it drifted
 * apart: two identical, three with different temp names and different permission handling.
 *
 * Synchronous, and there is no async sibling: every caller either sits on a path where a KB-sized
 * write must complete BEFORE a transport ACK (channel state — an ACKed delivery is not redelivered)
 * or on an interactive CLI flow where the cost is not observable. An async spelling would buy one of
 * them nothing and cost this module a second set of rules to keep true.
 */
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Write a file so a reader sees the whole thing or nothing: same-directory temp, then rename.
 *
 * The temp name is fixed (`<path>.tmp`). That is safe here because no two processes write one state
 * root: a deployment runs one container, `dev`'s supervisor respawns its worker only after the old
 * one has EXITED (dev-supervisor.ts), and the onboarding flows are one interactive command — and
 * these writes are synchronous, so an exited process has none in flight. The fixed name is also the seam several channel tests use to inject a write
 * failure, by occupying that path with a directory. A unique name would trade that seam for a race
 * this codebase does not have; revisit it if a second writer ever becomes real.
 *
 * `mode` is applied to the temp first, so the content is never briefly world-readable.
 *
 * The `chmod` is NOT redundant with the `mode` option: `writeFileSync` applies `mode` only when it
 * CREATES the file, so a temp left behind by a crashed writer keeps its old, possibly loose
 * permissions and the rename publishes them (verified: 0644 survives a `{ mode: 0o600 }` write).
 * It runs on the temp, before the rename — the final path is then never observable with the wrong
 * permissions, which a chmod after the rename cannot promise.
 */
export function writeFileAtomic(path: string, data: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, data, mode === undefined ? undefined : { mode });
    if (mode !== undefined) chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // `force` only forgives ENOENT: if the temp is a directory, rmSync throws its own error and
      // would replace the write failure that actually explains what went wrong.
    }
    throw error;
  }
}
