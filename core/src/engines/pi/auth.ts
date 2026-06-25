/**
 * Auth for the pi engine: a read-WRITE {@link CredentialStore} over fastagent's OWN credentials file
 * (`~/.fastagent/auth.json`), consumed by the `Models` collection (models.ts). pi 0.80 made auth
 * first-class: providers carry `ProviderAuth`, and the collection resolves per request through a
 * `CredentialStore` (stored credentials) plus an `AuthContext` (ambient env vars).
 *
 * fastagent owns this file, SEPARATE from the pi CLI's `~/.pi/agent/auth.json`:
 *   - two stores cannot share one OAuth refresh lifecycle (a rotated refresh token consumed by one
 *     would break the other), so fastagent never reads/copies pi's credential — `fastagent login`
 *     does a fresh login into this file;
 *   - the engine binding must not write the user's global pi state, nor be coupled to pi's private
 *     file location/format (engine-neutrality: a future engine binding owns its own auth).
 *
 * Persistence + locking reuse pi's `FileAuthStorageBackend` (a cross-process file lock) on the WRITE
 * path only. `read` is pi-ai's per-request hot path (`resolveProviderAuth` reads on every request,
 * "valid tokens cost zero locks"), so it stays UNLOCKED; the backend's in-place write opens only a
 * sub-millisecond torn-read window (during a rare OAuth rotation), which `read` absorbs by re-reading
 * rather than dragging a lock onto the hot path. The write path refuses to overwrite a corrupt file
 * (never clobbering other providers' credentials), and `delete` is a no-op that does not create it.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { FileAuthStorageBackend } from "@earendil-works/pi-coding-agent";

/** fastagent's own credentials file (written by `fastagent login`; distinct from pi's `~/.pi`). */
export const FASTAGENT_AUTH_PATH = join(homedir(), ".fastagent", "auth.json");

export interface FastagentAuthOptions {
  /**
   * Sink for non-fatal auth anomalies (unreadable/corrupt credentials file). Defaults to
   * console.warn (fail visibly out of the box); embedders inject their own logger.
   */
  warn?: (message: string) => void;
}

type Creds = Record<string, Credential>;

/** A valid stored credential, or undefined — a foreign/old entry reads as not-configured, not a crash. */
function pick(creds: Creds, providerId: string): Credential | undefined {
  const cred = creds[providerId];
  return cred && (cred.type === "oauth" || cred.type === "api_key") ? cred : undefined;
}

/**
 * Parse the credentials JSON for a WRITE: a corrupt file must THROW — serializing `{}` over it would
 * wipe every other provider's credentials. The throw aborts the locked write (the backend only writes
 * a returned `next`), so the corrupt file is left intact for the user to fix.
 */
function parseForWrite(raw: string | undefined, where: string): Creds {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Creds;
  } catch {
    throw new Error(`refusing to overwrite corrupt auth file ${where} — fix or remove it`);
  }
}

/**
 * A read-write `CredentialStore` backed by `~/.fastagent/auth.json`.
 *
 * - `read` returns the provider's stored credential (missing file/entry = not configured → the
 *   collection falls back to ambient env). Read under the lock, so a concurrent in-place write is
 *   never seen torn; a genuinely corrupt file reads lenient (warn + not-configured, no throw).
 * - `modify` is the serialized read-modify-write `Models.getAuth()` runs OAuth refresh inside: it
 *   locks the file, applies `fn`, and PERSISTS the result — a rotated refresh token is saved, not lost.
 * - `delete` removes the entry (logout); a no-op when nothing is stored, never creating the file.
 */
export function fastagentCredentialStore(
  authPath: string = FASTAGENT_AUTH_PATH,
  options: FastagentAuthOptions = {},
): CredentialStore {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const backend = new FileAuthStorageBackend(authPath);

  return {
    async read(providerId) {
      // Missing file = not configured (normal). UNLOCKED — this is pi-ai's per-request hot path; the
      // only race is a sub-millisecond in-place write during an OAuth rotation, which can yield an
      // empty/partial file. Re-read a few times before concluding the file is genuinely corrupt; a
      // valid `{}` (provider simply absent) returns immediately, so a not-configured read costs nothing.
      for (let attempt = 0; attempt < 3; attempt++) {
        let raw: string;
        try {
          raw = readFileSync(authPath, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; // missing/deleted
          warn(`[fastagent] cannot read ${authPath}: ${(error as Error).message}`);
          return undefined;
        }
        if (raw !== "") {
          try {
            return pick(JSON.parse(raw) as Creds, providerId);
          } catch {
            // A partial read mid-write parses as garbage — fall through and retry.
          }
        }
        if (attempt < 2) await sleep(2); // the write window is tiny; let it finish, then re-read
      }
      warn(`[fastagent] corrupt auth file ${authPath} — fix or remove it`); // still bad after retries
      return undefined;
    },
    modify(providerId, fn) {
      return backend.withLockAsync(async (current) => {
        const creds = parseForWrite(current, authPath); // corrupt → throw → no write (no clobber)
        const next = await fn(pick(creds, providerId));
        if (next === undefined) return { result: pick(creds, providerId) }; // unchanged: no write
        creds[providerId] = next;
        return { result: next, next: `${JSON.stringify(creds, null, 2)}\n` };
      });
    },
    async delete(providerId) {
      // No-op when there is nothing to remove: do NOT take the lock (which would create the file via
      // the backend's ensureFileExists) on a machine that never stored this provider.
      if (!existsSync(authPath)) return;
      await backend.withLockAsync(async (current) => {
        const creds = parseForWrite(current, authPath); // corrupt → throw → no clobber
        if (!(providerId in creds)) return { result: undefined }; // absent: no write
        delete creds[providerId];
        return { result: undefined, next: `${JSON.stringify(creds, null, 2)}\n` };
      });
    },
  };
}
