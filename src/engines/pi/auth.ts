/**
 * Auth for the pi engine: a read-WRITE {@link CredentialStore} over a fastagent credentials file, consumed by the
 * `Models` collection (models.ts). The write path refuses to overwrite a corrupt file, so a torn read never clobbers
 * the other providers' credentials.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { GLOBAL_HOME_DIR, SECRETS_DIRNAME, SECRET_FILE_MODE, ensureSecretsDir } from "../../paths.ts";
import { writeFileAtomic } from "../../atomic-write.ts";
import { log } from "../../log.ts";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import lockfile from "proper-lockfile";

/**
 * The GLOBAL fastagent credentials file (distinct from pi's `~/.pi`), under the user-global machinery home
 * `~/.fastagent/`.
 */
export const GLOBAL_AUTH_PATH = join(homedir(), GLOBAL_HOME_DIR, SECRETS_DIRNAME, "auth.json");

export interface FastagentAuthOptions {
  /** Sink for non-fatal auth anomalies (unreadable/corrupt file). */
  warn?: (message: string) => void;
}

type Creds = Record<string, Credential>;

/** A valid stored credential, or undefined — a foreign/old entry reads as not-configured, not a crash. */
function pick(creds: Creds, providerId: string): Credential | undefined {
  const cred = creds[providerId];
  return cred && (cred.type === "oauth" || cred.type === "api_key") ? cred : undefined;
}

const AUTH_FILE_WRITE_OPTIONS = { encoding: "utf8", mode: SECRET_FILE_MODE } as const;

interface LockResult<T> {
  result: T;
  /** New file content to persist under the lock; undefined = no write. */
  next?: string;
}

/** Serialized cross-process read-modify-write of the credentials file. */
async function withLockedAuthFile<T>(
  authPath: string,
  fn: (current: string | undefined) => Promise<LockResult<T>>,
): Promise<T> {
  // 0700 unconditionally, including on a directory an operator named with `--auth-path`.
  await ensureSecretsDir(dirname(authPath));
  if (!existsSync(authPath)) {
    try {
      writeFileSync(authPath, "{}", { ...AUTH_FILE_WRITE_OPTIONS, flag: "wx" });
      chmodSync(authPath, SECRET_FILE_MODE);
    } catch (error) {
      // EEXIST: another process created the file between the existence check and this exclusive create; its content
      // (possibly already-written credentials) must not be clobbered.
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
    // Rename, not an in-place rewrite: it is what lets `read` stay unlocked, and it is the only spelling that applies
    // the mode before the content is reachable.
    if (out.next !== undefined) writeFileAtomic(authPath, out.next, SECRET_FILE_MODE);
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
  // Success path: a failed release is a real cleanup failure (the leftover auth.json.lock stalls the next writer for
  // the staleness window with zero diagnostics), so it surfaces instead of resolving a silently degraded operation.
  try {
    await release();
  } catch (releaseError) {
    if (compromised === undefined) throw releaseError;
  }
  throwIfCompromised();
  return result;
}

/** Decode the credentials JSON, shared by the read and write paths. */
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

/** UNLOCKED read of the whole credentials file, shared by `read` and `list`. */
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
 * Parse the credentials JSON for a WRITE: a corrupt file must THROW, because serializing `{}` over it would wipe every
 * other provider's credentials.
 */
function parseForWrite(raw: string | undefined, where: string): Creds {
  if (!raw) return {};
  const creds = decodeCreds(raw);
  if (creds === undefined) {
    throw new Error(`refusing to overwrite corrupt auth file ${where}: fix or remove it`);
  }
  return creds;
}

/**
 * A read-write `CredentialStore` over the given credentials file (default {@link GLOBAL_AUTH_PATH}; the directory
 * opener passes the project-level `<root>/.secrets/auth.json`), optionally falling back to a second file.
 *
 * The fallback is PER PROVIDER, not per file: logging one provider into a project must not hide the others a person
 * already has globally. And the layer a credential was READ from is the layer its refresh is written back to —
 * anything else would conjure a second holder of the same OAuth grant, which is the failure this whole area exists
 * to avoid. A provider present in neither layer is new, and new credentials belong to the primary.
 */
export function fastagentCredentialStore(
  authPath: string = GLOBAL_AUTH_PATH,
  options: FastagentAuthOptions & { fallbackPath?: string } = {},
): CredentialStore {
  const warn = options.warn ?? ((message: string) => log.warn(message));
  const fallback =
    options.fallbackPath !== undefined && options.fallbackPath !== authPath ? options.fallbackPath : undefined;
  /** The file that owns this provider: where it already is, else the primary. */
  const owner = (providerId: string): string => {
    if (fallback === undefined) return authPath;
    const primary = readCreds(authPath, warn);
    if (primary && pick(primary, providerId)) return authPath;
    const secondary = readCreds(fallback, warn);
    return secondary && pick(secondary, providerId) ? fallback : authPath;
  };

  return {
    async read(providerId) {
      for (const path of fallback === undefined ? [authPath] : [authPath, fallback]) {
        const creds = readCreds(path, warn);
        const found = creds && pick(creds, providerId);
        if (found) return found;
      }
      return undefined;
    },
    async list() {
      // Metadata only, never secrets (the pi-ai `list` contract). Reverse order, so the primary's entry for a
      // provider present in both overwrites the fallback's — the same precedence `read` applies.
      const infos = new Map<string, CredentialInfo>();
      for (const path of fallback === undefined ? [authPath] : [fallback, authPath]) {
        for (const [providerId, cred] of Object.entries(readCreds(path, warn) ?? {})) {
          if (cred && (cred.type === "oauth" || cred.type === "api_key"))
            infos.set(providerId, { providerId, type: cred.type });
        }
      }
      return [...infos.values()];
    },
    modify(providerId, fn) {
      const path = owner(providerId);
      return withLockedAuthFile(path, async (current) => {
        const creds = parseForWrite(current, path); // corrupt → throw → no clobber
        const next = await fn(pick(creds, providerId));
        if (next === undefined) return { result: pick(creds, providerId) }; // unchanged: no write
        creds[providerId] = next;
        return { result: next, next: `${JSON.stringify(creds, null, 2)}\n` };
      });
    },
    async delete(providerId) {
      const path = owner(providerId);
      // No-op when nothing is stored: do NOT take the lock (which would create the file) on a machine that never
      // stored this provider.
      if (!existsSync(path)) return;
      await withLockedAuthFile(path, async (current) => {
        const creds = parseForWrite(current, path);
        if (!(providerId in creds)) return { result: undefined }; // absent: no write
        delete creds[providerId];
        return { result: undefined, next: `${JSON.stringify(creds, null, 2)}\n` };
      });
    },
  };
}
