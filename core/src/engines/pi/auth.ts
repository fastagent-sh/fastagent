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
 * Persistence + locking reuse pi's `FileAuthStorageBackend` (a cross-process file lock). The lock is
 * the ONLY thing reused — every other write-safety property is enforced here, because the backend
 * writes in place (not atomic temp+rename): so all access (incl. `read`) goes through the lock to
 * avoid torn reads, the write path refuses to overwrite a corrupt file (never clobbering other
 * providers' credentials), and `delete` is a no-op that does not create the file.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
      // Missing file = not configured (normal); pre-check so a read never CREATES the file.
      if (!existsSync(authPath)) return undefined;
      try {
        // Same lock the writes take (the backend writes in place), so a concurrent OAuth-rotation
        // write can't be seen torn. Under the lock, a parse failure IS real corruption, not a race.
        return await backend.withLockAsync(async (current) => {
          if (!current) return { result: undefined };
          let creds: Creds;
          try {
            creds = JSON.parse(current) as Creds;
          } catch {
            warn(`[fastagent] corrupt auth file ${authPath} — fix or remove it`);
            return { result: undefined };
          }
          return { result: pick(creds, providerId) };
        });
      } catch (error) {
        // read is display/status — never throw (a lock/IO error degrades to not-configured + a warn).
        warn(`[fastagent] cannot read ${authPath}: ${(error as Error).message}`);
        return undefined;
      }
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
