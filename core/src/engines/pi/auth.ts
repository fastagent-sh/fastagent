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
 * Reading is a parse-and-index; writing is the OAuth-refresh path — `Models.getAuth`
 * runs token refresh inside `modify`, so the rotated credential MUST be persisted
 * or the next request/restart reads a refresh token the provider already
 * invalidated (see {@link piCredentialStore}). fastagent still never initiates
 * login: that is the pi CLI's job.
 *
 * Process-level global side effects (e.g. the undici proxy dispatcher) do NOT
 * belong here: those are the application entry point's responsibility.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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

/** Type-guard a parsed entry to a known `Credential`; foreign/old entries → undefined. */
function asCredential(value: unknown): Credential | undefined {
  if (value && typeof value === "object") {
    const type = (value as { type?: unknown }).type;
    if (type === "oauth" || type === "api_key") return value as Credential;
  }
  return undefined;
}

/**
 * A `CredentialStore` backed by pi's `~/.pi/agent/auth.json`.
 *
 * `read` parses the file and returns the provider's stored credential (OAuth
 * coding-plan token or `api_key` entry). Missing file / missing entry = not
 * configured (the collection then falls back to ambient env vars); a corrupt
 * file is surfaced via `warn` (fail visibly) and treated as not configured.
 *
 * **Writes persist.** pi 0.80 resolves OAuth by refreshing the token inside
 * `modify`, and the provider rotates its refresh token on every refresh — so the
 * rotated credential is written back atomically (temp file + rename, mode 0600),
 * preserving every other provider's entry. Without this the on-disk refresh
 * token goes stale after the first refresh and later requests/restarts fail with
 * 401 until the user re-runs `pi` login. `delete` removes a provider's entry.
 * fastagent never initiates login (that is the pi CLI's job); it only persists
 * the upstream refresh and an explicit logout.
 *
 * Mutual exclusion is per-provider and in-process (a promise chain): concurrent
 * requests in a long-running `start`/`dev` cannot double-refresh a rotated token.
 * Cross-process safety is best-effort — the atomic rename prevents torn writes,
 * and pi's double-checked expiry under `modify` collapses redundant refreshes.
 */
export function piCredentialStore(authPath: string = PI_AUTH_PATH, options: PiAuthOptions = {}): CredentialStore {
  const warn = options.warn ?? ((message: string) => console.warn(message));

  // Read the whole on-disk record. ENOENT = empty (not configured / pre-login);
  // a corrupt parse is surfaced via `warn`. `onCorrupt` lets the write path turn
  // an unreadable/corrupt file into a hard failure so a persist never clobbers
  // other providers' credentials by overwriting a file it could not parse.
  const readRecord = (onCorrupt: (message: string) => void): Record<string, unknown> => {
    let raw: string;
    try {
      raw = readFileSync(authPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        warn(`[fastagent] cannot read ${authPath}: ${(error as Error).message}`);
        onCorrupt(`cannot read ${authPath}: ${(error as Error).message}`);
      }
      return {};
    }
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      warn(`[fastagent] corrupt auth file ${authPath}; run pi to re-login`);
      onCorrupt(`corrupt auth file ${authPath}`);
      return {};
    }
  };

  // Atomic write: a fresh temp file (mode 0600 — never widen secret perms) then
  // rename over the target, so a concurrent `read` sees one complete version.
  const persist = (record: Record<string, unknown>): void => {
    mkdirSync(dirname(authPath), { recursive: true });
    const tmp = `${authPath}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, authPath);
  };

  // Serialize tasks per provider id (the only write path is `modify`/`delete`).
  const chains = new Map<string, Promise<unknown>>();
  const enqueue = <T>(providerId: string, task: () => Promise<T>): Promise<T> => {
    const previous = chains.get(providerId) ?? Promise.resolve();
    const next = (async () => {
      await previous.catch(() => {});
      return task();
    })();
    chains.set(
      providerId,
      next.catch(() => {}),
    );
    return next;
  };

  return {
    read(providerId) {
      // Display/status read: a corrupt file is not "not configured", but it must
      // not crash resolution — warn (above) and report unconfigured.
      const record = readRecord(() => {});
      return Promise.resolve(asCredential(record[providerId]));
    },
    modify(providerId, fn) {
      return enqueue(providerId, async () => {
        const record = readRecord((message) => {
          throw new Error(message); // never overwrite an unreadable/corrupt file
        });
        const current = asCredential(record[providerId]);
        const next = await fn(current);
        if (next !== undefined) {
          record[providerId] = next;
          persist(record);
        }
        return next ?? current;
      });
    },
    delete(providerId) {
      return enqueue(providerId, async () => {
        const record = readRecord((message) => {
          throw new Error(message);
        });
        if (!(providerId in record)) return;
        delete record[providerId];
        persist(record);
      });
    },
  };
}
