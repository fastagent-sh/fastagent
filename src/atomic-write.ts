/** One spelling of "a reader sees the whole file or none of it", after five copies of it drifted apart. */
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Write a file so a reader sees the whole thing or nothing: same-directory temp, then rename.
 *
 * The temp name is FIXED (`<path>.tmp`), which rests on one process writing one state root: a deployment runs one
 * container, `dev`'s supervisor respawns its worker only after the old one has exited, and these writes are
 * synchronous. Slack's onboarding state is the documented exception (`add slack` plus the config-token rotation at
 * `--tunnel` startup); it stays fixed because that window is one rare, self-repairing write, and because the fixed
 * name is the seam channel tests use to inject a write failure. Revisit before adding a writer that is neither.
 *
 * `mode` is applied to the temp first, so the content is never briefly world-readable, and the `chmod` is not
 * redundant with it: `writeFileSync` honours `mode` only when it CREATES the file, so a temp left behind by a crashed
 * writer would keep its old, possibly looser permissions.
 */
export function writeFileAtomic(path: string, data: string | Buffer, mode?: number): void {
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
      // `force` only forgives ENOENT: if the temp is a directory, rmSync throws its own error and would replace the
      // write failure that actually explains what went wrong.
    }
    throw error;
  }
}
