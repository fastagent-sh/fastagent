/** One spelling of "a reader sees the whole file or none of it", after five copies of it drifted apart. */
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Write a file so a reader sees the whole thing or nothing: same-directory temp, then rename. */
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
