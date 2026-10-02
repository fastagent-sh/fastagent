/**
 * The one cross-process read-modify-write for a JSON file several processes share: fastagent's credentials file and a
 * model catalog. It takes the lock pi takes for the same files (pi-coding-agent's `FileAuthStorageBackend`), so a
 * fastagent writer and a pi writer queue behind each other, and it REPLACES the file rather than rewriting it in
 * place, which is what lets every reader of these files read without the lock: a reader sees the old file or the new
 * one, never one cut short.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { writeFileAtomic } from "../../atomic-write.ts";
import { SECRET_FILE_MODE } from "../../paths.ts";

const WRITE_OPTIONS = { encoding: "utf8", mode: SECRET_FILE_MODE } as const;

export interface LockResult<T> {
  result: T;
  /** New file content to persist under the lock; undefined = no write. */
  next?: string;
}

/**
 * The file a write must land IN, which is not always the path it is addressed BY. pi writes these files in place,
 * so it follows a symlink to the target; an atomic rename would replace the link with a regular file instead, and
 * from then on the two tools would be editing different files — the same split the shared lock exists to prevent,
 * arriving one write later. A dangling link (a dotfile manager that has not checked the target out yet) still names
 * where the content belongs, so it is followed too rather than overwritten.
 */
function writeTarget(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const link = lstatSync(path, { throwIfNoEntry: false });
  // ponytail: one hop. A chain of dangling links would have its second link replaced; resolve iteratively if that
  // ever shows up in a real layout.
  return link?.isSymbolicLink() ? resolve(dirname(path), readlinkSync(path)) : path;
}

/** Serialized cross-process read-modify-write of one file, replaced whole so its readers need no lock. */
export async function withLockedFile<T>(
  path: string,
  fn: (current: string | undefined) => Promise<LockResult<T>>,
): Promise<T> {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    try {
      // `wx` makes this an exclusive CREATE, which is the one case `writeFileSync` honours `mode` in — so no chmod
      // after it (unlike writeFileAtomic, whose temp may already exist from a crashed writer).
      writeFileSync(path, "{}", { ...WRITE_OPTIONS, flag: "wx" });
    } catch (error) {
      // EEXIST: the path IS taken, by something `existsSync` does not see through — either another process created
      // the file just now (its content must not be clobbered) or the path is a dangling symlink. Both are left
      // alone: the write below resolves where they belong.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  let compromised: Error | undefined;
  const throwIfCompromised = () => {
    if (compromised) throw compromised;
  };

  const release = await lockfile.lock(path, {
    // MUST match pi-coding-agent's `core/auth-storage.js`, which locks with `realpath: false`. When the file
    // itself is a symlink (dotfile managers do this), the two settings name DIFFERENT lock files and both locks can
    // be held at once — so `pi` and `fastagent` would refresh the same provider concurrently, and a rotated refresh
    // token logs one of them out. Resolving the link would be the stronger rule, but only if BOTH sides did it, and
    // we do not own the other side.
    realpath: false,
    retries: { retries: 10, factor: 2, minTimeout: 100, maxTimeout: 10_000, randomize: true },
    stale: 30_000,
    onCompromised: (error) => {
      compromised = error;
    },
  });
  let result: T;
  try {
    throwIfCompromised();
    const current = existsSync(path) ? readFileSync(path, "utf8") : undefined;
    const out = await fn(current);
    throwIfCompromised();
    // Rename, not an in-place rewrite: it is what lets `read` stay unlocked, and it is the only spelling that applies
    // the mode before the content is reachable.
    if (out.next !== undefined) {
      writeFileAtomic(writeTarget(path), out.next, SECRET_FILE_MODE);
    }
    throwIfCompromised();
    result = out.result;
  } catch (error) {
    // The primary failure stays the signal; unlock noise must not mask it.
    try {
      await release();
    } catch {
      // Secondary: a compromised or stale-reclaimed lock often cannot release cleanly.
    }
    throw error;
  }
  // Success path: a failed release is a real cleanup failure (the leftover `<file>.lock` stalls the next writer for
  // the staleness window with zero diagnostics), so it surfaces instead of resolving a silently degraded operation.
  try {
    await release();
  } catch (releaseError) {
    if (compromised === undefined) throw releaseError;
  }
  throwIfCompromised();
  return result;
}
