/**
 * Auth for the pi engine: a read-WRITE {@link CredentialStore} over a fastagent credentials file,
 * consumed by the `Models` collection (models.ts). The path is project-level by default
 * (`<agentDir>/.secrets/auth.json`, resolved by the opener); {@link GLOBAL_AUTH_PATH} is the
 * global location used as the override target / login default, not an implicit per-provider fallback.
 *
 * Project-level default + NO implicit project↔global fallback, for two reasons: (1) isolation — each
 * agent can use a different account/subscription; (2) fail-visibly — a missing credential surfaces at
 * startup instead of being masked by a machine-global one that won't exist on a fresh deploy box. A
 * *fallback* specifically is refused because the only safe shape (read global, write the rotated token
 * back to the project file) would diverge: OAuth refresh tokens are single-use, so consuming global's
 * token and persisting the new one elsewhere leaves global stale for every other consumer.
 *
 * Sharing is still SAFE the right way: point everything at ONE file (`FASTAGENT_AUTH_PATH` → the
 * global path). One file means one refresh lifecycle under the store's cross-process write lock
 * (refresh re-reads the latest token under the lock), the documented same-machine pattern.
 * fastagent's store stays SEPARATE from the pi CLI's `~/.pi/agent/auth.json` for the same single-
 * lifecycle reason: two uncoordinated files over one grant would each rotate and break the other.
 *
 * Locking is vendored here on `proper-lockfile`, with the same parameters pi's file backend used
 * before pi 0.80.8 stopped exporting it (upstream's stated migration path for SDK consumers is a
 * custom pi-ai `CredentialStore`, which this file is). The lock guards the WRITE path only. `read`
 * is pi-ai's per-request hot path, so it stays UNLOCKED — safe because the write publishes by
 * rename ({@link writeFileAtomic}): a reader sees one whole version of the file or another, never a
 * partial one, so there is no torn-read window for an unlocked read to absorb. The write path
 * refuses to overwrite a corrupt file (never clobbering other providers' credentials).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { GLOBAL_HOME_DIR, SECRETS_DIRNAME } from "../../paths.ts";
import { writeFileAtomic } from "../../atomic-write.ts";
import { log } from "../../log.ts";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import lockfile from "proper-lockfile";

/**
 * The GLOBAL fastagent credentials file (distinct from pi's `~/.pi`), under the user-global machinery
 * home `~/.fastagent/` — which carries the same unified shape as a workspace (`.secrets/auth.json`).
 * The project-level default is `<agentDir>/.secrets/auth.json` (computed by the opener and by
 * `fastagent login`); this is only the `loginFlow()` PROGRAMMATIC fallback (when a caller omits
 * `authPath`) and the path to point `--auth-path`/`FASTAGENT_AUTH_PATH` at to deliberately share ONE
 * credential file across projects (safe — one file, one lock-serialized refresh lifecycle). The
 * `fastagent login` CLI is project-level by default, never this.
 */
export const GLOBAL_AUTH_PATH = join(homedir(), GLOBAL_HOME_DIR, SECRETS_DIRNAME, "auth.json");

export interface FastagentAuthOptions {
  /** Sink for non-fatal auth anomalies (unreadable/corrupt file). Defaults to the process logger (warn). */
  warn?: (message: string) => void;
}

type Creds = Record<string, Credential>;

/** A valid stored credential, or undefined — a foreign/old entry reads as not-configured, not a crash. */
function pick(creds: Creds, providerId: string): Credential | undefined {
  const cred = creds[providerId];
  return cred && (cred.type === "oauth" || cred.type === "api_key") ? cred : undefined;
}

const AUTH_FILE_WRITE_OPTIONS = { encoding: "utf8", mode: 0o600 } as const;

interface LockResult<T> {
  result: T;
  /** New file content to persist under the lock; undefined = no write. */
  next?: string;
}

/**
 * Serialized cross-process read-modify-write of the credentials file: exponential-backoff retries,
 * 30s staleness, and compromise detection (the parameters pi's `FileAuthStorageBackend` used).
 * Ensures the file exists first (0700 dir, 0600 file, EXCLUSIVE create: a concurrent first write
 * must never be clobbered by the init) because `proper-lockfile` locks an existing path. A
 * compromised lock aborts before the write rather than clobbering a concurrent writer, and a
 * failed unlock after a successful operation rejects instead of leaving a stale lock silently.
 */
async function withLockedAuthFile<T>(
  authPath: string,
  fn: (current: string | undefined) => Promise<LockResult<T>>,
): Promise<T> {
  const dir = dirname(authPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!existsSync(authPath)) {
    try {
      writeFileSync(authPath, "{}", { ...AUTH_FILE_WRITE_OPTIONS, flag: "wx" });
      chmodSync(authPath, 0o600);
    } catch (error) {
      // EEXIST: another process created the file between the existence check and this exclusive
      // create; its content (possibly already-written credentials) must not be clobbered.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  let compromised: Error | undefined;
  const throwIfCompromised = () => {
    if (compromised) throw compromised;
  };

  const release = await lockfile.lock(authPath, {
    retries: { retries: 10, factor: 2, minTimeout: 100, maxTimeout: 10_000, randomize: true },
    stale: 30_000,
    onCompromised: (error) => {
      compromised = error;
    },
  });
  let result: T;
  try {
    throwIfCompromised();
    const current = existsSync(authPath) ? readFileSync(authPath, "utf8") : undefined;
    const out = await fn(current);
    throwIfCompromised();
    // Rename, not an in-place rewrite: it is what lets `read` stay unlocked, and it is the only
    // spelling that applies the mode before the content is reachable — `writeFileSync`'s `mode` is
    // a no-op on an existing file, so a chmod after it leaves the new credential briefly readable
    // at whatever mode the old file carried.
    if (out.next !== undefined) writeFileAtomic(authPath, out.next, 0o600);
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
  // Success path: a failed release is a real cleanup failure (the leftover auth.json.lock stalls
  // the next writer for the staleness window with zero diagnostics), so it surfaces instead of
  // resolving a silently degraded operation. A compromise detected after the last in-band check
  // surfaces here too.
  try {
    await release();
  } catch (releaseError) {
    if (compromised === undefined) throw releaseError;
  }
  throwIfCompromised();
  return result;
}

/**
 * Decode the credentials JSON, shared by the read and write paths. The root must be a plain
 * non-null, non-array object: `[]`, `null`, and scalar roots pass JSON.parse but break the record
 * semantics (an array root even swallows writes, since JSON.stringify drops string keys on arrays).
 * Structurally invalid = corrupt, exactly like unparsable text.
 */
function decodeCreds(raw: string): Creds | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  return parsed as Creds;
}

/**
 * UNLOCKED read of the whole credentials file, shared by `read` and `list`. ONE read: the write
 * publishes by rename, so this observes one whole version or another and has nothing to absorb by
 * re-reading. A missing file reads as undefined silently (normal not-configured); anything that
 * does not decode is a real corruption — a hand-edit — and says so immediately, rather than after
 * retrying a race that cannot happen.
 */
function readCreds(authPath: string, warn: (message: string) => void): Creds | undefined {
  let raw: string;
  try {
    raw = readFileSync(authPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; // missing/deleted
    warn(`[fastagent] cannot read ${authPath}: ${(error as Error).message}`);
    return undefined;
  }
  const creds = raw === "" ? undefined : decodeCreds(raw);
  if (creds !== undefined) return creds;
  warn(`[fastagent] corrupt auth file ${authPath}: fix or remove it`);
  return undefined;
}

/**
 * Parse the credentials JSON for a WRITE: a corrupt file must THROW, because serializing `{}` over
 * it would wipe every other provider's credentials. The throw aborts the locked write, leaving the
 * file intact.
 */
function parseForWrite(raw: string | undefined, where: string): Creds {
  if (!raw) return {};
  const creds = decodeCreds(raw);
  if (creds === undefined) {
    throw new Error(`refusing to overwrite corrupt auth file ${where}: fix or remove it`);
  }
  return creds;
}

/** A read-write `CredentialStore` backed by the given credentials file (default {@link GLOBAL_AUTH_PATH};
 *  the directory opener passes the project-level `<root>/.secrets/auth.json`). */
export function fastagentCredentialStore(
  authPath: string = GLOBAL_AUTH_PATH,
  options: FastagentAuthOptions = {},
): CredentialStore {
  const warn = options.warn ?? ((message: string) => log.warn(message));

  return {
    async read(providerId) {
      const creds = readCreds(authPath, warn);
      return creds ? pick(creds, providerId) : undefined;
    },
    async list() {
      // Metadata only, never secrets (the pi-ai `list` contract). Foreign/old entries are filtered
      // with the same validation as `read`, so both surfaces agree on what "configured" means.
      const creds = readCreds(authPath, warn);
      if (!creds) return [];
      const infos: CredentialInfo[] = [];
      for (const [providerId, cred] of Object.entries(creds)) {
        if (cred && (cred.type === "oauth" || cred.type === "api_key")) {
          infos.push({ providerId, type: cred.type });
        }
      }
      return infos;
    },
    modify(providerId, fn) {
      return withLockedAuthFile(authPath, async (current) => {
        const creds = parseForWrite(current, authPath); // corrupt → throw → no clobber
        const next = await fn(pick(creds, providerId));
        if (next === undefined) return { result: pick(creds, providerId) }; // unchanged: no write
        creds[providerId] = next;
        return { result: next, next: `${JSON.stringify(creds, null, 2)}\n` };
      });
    },
    async delete(providerId) {
      // No-op when nothing is stored: do NOT take the lock (which would create the file) on a
      // machine that never stored this provider.
      if (!existsSync(authPath)) return;
      await withLockedAuthFile(authPath, async (current) => {
        const creds = parseForWrite(current, authPath);
        if (!(providerId in creds)) return { result: undefined }; // absent: no write
        delete creds[providerId];
        return { result: undefined, next: `${JSON.stringify(creds, null, 2)}\n` };
      });
    },
  };
}
