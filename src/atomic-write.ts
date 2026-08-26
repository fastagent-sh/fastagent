/**
 * One spelling of "a reader sees the whole file or none of it", after four copies of it drifted
 * apart: two identical, two with different temp names and different permission handling.
 */
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Write a file so a reader sees the whole thing or nothing: same-directory temp, then rename.
 *
 * The temp name is fixed (`<path>.tmp`), which is safe under this codebase's single-process state
 * assumption and is also how several tests inject a write failure — occupying that path with a
 * directory. `mode` is applied to the temp first, so the content is never briefly world-readable.
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
