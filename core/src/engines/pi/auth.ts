/**
 * Auth for the pi engine: a {@link CredentialStore} over pi's local credentials
 * file (`~/.pi/agent/auth.json`), consumed by the `Models` collection (see
 * models.ts). pi 0.80 made auth first-class: providers carry their own
 * `ProviderAuth`, the collection resolves per request through a `CredentialStore`
 * (stored credentials) plus an `AuthContext` (ambient env vars). This module
 * supplies the store; env fallback is upstream-automatic.
 *
 * The on-disk file IS the `CredentialStore` shape: a `Record<providerId, Credential>`
 * where each `Credential` is `{type:"oauth",...}` or `{type:"api_key",...}`.
 * So reading is a parse-and-index; fastagent never logs in (that is the pi CLI's
 * job), so writes are intentionally NOT persisted — see {@link piCredentialStore}.
 *
 * Process-level global side effects (e.g. the undici proxy dispatcher) do NOT
 * belong here: those are the application entry point's responsibility.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";

/** pi's local credentials file (written by the pi CLI). */
const PI_AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");

export interface PiAuthOptions {
  /**
   * Sink for non-fatal auth anomalies (unreadable/corrupt credentials file).
   * Defaults to console.warn (fail visibly out of the box); embedders inject
   * their own logger — the observability decision is not baked into the library.
   */
  warn?: (message: string) => void;
}

/**
 * A read-only `CredentialStore` backed by pi's `~/.pi/agent/auth.json`.
 *
 * `read` parses the file and returns the provider's stored credential (OAuth
 * coding-plan token or `api_key` entry). Missing file / missing entry = not
 * configured (the collection then falls back to ambient env vars); a corrupt
 * file is surfaced via `warn` (fail visibly) and treated as not configured.
 *
 * **Writes are not persisted.** The pi CLI owns login/logout and token
 * persistence; fastagent only reads. `modify` therefore runs the caller's
 * function against the freshly-read credential and returns the result WITHOUT
 * writing back — so an upstream OAuth refresh still produces a valid token for
 * the in-flight request (a strict improvement over the old reader, which failed
 * on an expired token), it just is not saved. `delete` is a no-op.
 */
export function piCredentialStore(authPath: string = PI_AUTH_PATH, options: PiAuthOptions = {}): CredentialStore {
  const warn = options.warn ?? ((message: string) => console.warn(message));

  const read = (providerId: string): Promise<Credential | undefined> => {
    let raw: string;
    try {
      raw = readFileSync(authPath, "utf8");
    } catch (error) {
      // Missing file = not configured (normal). Anything else must be visible.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        warn(`[fastagent] cannot read ${authPath}: ${(error as Error).message}`);
      }
      return Promise.resolve(undefined);
    }
    let creds: Record<string, Credential>;
    try {
      creds = JSON.parse(raw);
    } catch {
      // Corrupt credentials are an anomaly, not "not configured" — warn so the
      // root cause is diagnosable instead of a confusing downstream auth failure.
      warn(`[fastagent] corrupt auth file ${authPath}; run pi to re-login`);
      return Promise.resolve(undefined);
    }
    const cred = creds[providerId];
    // Guard the discriminator: a foreign/old entry must read as not-configured,
    // not crash auth resolution downstream.
    if (cred && (cred.type === "oauth" || cred.type === "api_key")) {
      return Promise.resolve(cred);
    }
    return Promise.resolve(undefined);
  };

  return {
    read,
    async modify(providerId, fn) {
      // Non-persisting: run against current, return the result, do not write.
      return fn(await read(providerId));
    },
    delete() {
      return Promise.resolve();
    },
  };
}
