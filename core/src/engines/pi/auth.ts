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
 * Persistence + locking reuse pi's `FileAuthStorageBackend` (a cross-process file lock), so the OAuth
 * refresh `Models.getAuth()` runs INSIDE `modify` rotates AND saves the token — the write whose
 * absence would otherwise desync `auth.json` on a rotation.
 */
import { readFileSync } from "node:fs";
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

function parse(raw: string | undefined, warn: (m: string) => void, where: string): Creds {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Creds;
  } catch {
    // Corrupt credentials are an anomaly, not "not configured" — warn so the root cause is
    // diagnosable instead of a confusing downstream auth failure.
    warn(`[fastagent] corrupt auth file ${where}; run \`fastagent login\` to re-authenticate`);
    return {};
  }
}

/**
 * A read-write `CredentialStore` backed by `~/.fastagent/auth.json`.
 *
 * - `read` returns the provider's stored credential (a snapshot; missing file/entry = not configured,
 *   so the collection falls back to ambient env vars).
 * - `modify` is the serialized read-modify-write `Models.getAuth()` runs OAuth refresh inside: it
 *   locks the file (pi's `FileAuthStorageBackend`, cross-process), applies `fn` to the current
 *   credential, and PERSISTS the result — so a rotated refresh token is saved, not consumed-and-lost.
 * - `delete` removes the entry (logout), serialized against `modify`.
 */
export function fastagentCredentialStore(
  authPath: string = FASTAGENT_AUTH_PATH,
  options: FastagentAuthOptions = {},
): CredentialStore {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const backend = new FileAuthStorageBackend(authPath);

  return {
    read(providerId) {
      let raw: string | undefined;
      try {
        raw = readFileSync(authPath, "utf8");
      } catch (error) {
        // Missing file = not configured (normal). Anything else must be visible.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          warn(`[fastagent] cannot read ${authPath}: ${(error as Error).message}`);
        }
        return Promise.resolve(undefined);
      }
      return Promise.resolve(pick(parse(raw, warn, authPath), providerId));
    },
    modify(providerId, fn) {
      return backend.withLockAsync(async (current) => {
        const creds = parse(current, warn, authPath);
        const next = await fn(pick(creds, providerId));
        if (next === undefined) return { result: pick(creds, providerId) }; // unchanged: no write
        creds[providerId] = next;
        return { result: next, next: `${JSON.stringify(creds, null, 2)}\n` };
      });
    },
    delete(providerId) {
      return backend.withLockAsync(async (current) => {
        const creds = parse(current, warn, authPath);
        delete creds[providerId];
        return { result: undefined, next: `${JSON.stringify(creds, null, 2)}\n` };
      });
    },
  };
}
