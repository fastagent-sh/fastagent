/**
 * Auth for the pi engine: a read-WRITE {@link CredentialStore} over a fastagent credentials file,
 * consumed by the `Models` collection (models.ts). The path is project-level by default
 * (`<dir>/.fastagent/auth.json`, resolved by the opener); {@link GLOBAL_AUTH_PATH} is the global
 * location used as the override target / login default, not an implicit per-provider fallback.
 *
 * Project-level default + NO implicit project↔global fallback, for two reasons: (1) isolation — each
 * agent can use a different account/subscription; (2) fail-visibly — a missing credential surfaces at
 * startup instead of being masked by a machine-global one that won't exist on a fresh deploy box. A
 * *fallback* specifically is refused because the only safe shape (read global, write the rotated token
 * back to the project file) would diverge: OAuth refresh tokens are single-use, so consuming global's
 * token and persisting the new one elsewhere leaves global stale for every other consumer.
 *
 * Sharing is still SAFE the right way: point everything at ONE file (`FASTAGENT_AUTH_PATH` → the
 * global path). One file means one refresh lifecycle under `FileAuthStorageBackend`'s cross-process
 * lock (refresh re-reads the latest token under the lock) — the documented same-machine pattern.
 * fastagent's store stays SEPARATE from the pi CLI's `~/.pi/agent/auth.json` for the same single-
 * lifecycle reason: two uncoordinated files over one grant would each rotate and break the other.
 *
 * Persistence + locking reuse pi's `FileAuthStorageBackend` (a cross-process file lock) on the WRITE
 * path only. `read` is pi-ai's per-request hot path, so it stays UNLOCKED; the backend's in-place
 * write opens only a sub-millisecond torn-read window, which `read` absorbs by re-reading. The write
 * path refuses to overwrite a corrupt file (never clobbering other providers' credentials).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../../log.ts";
import { setTimeout as sleep } from "node:timers/promises";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { FileAuthStorageBackend } from "@earendil-works/pi-coding-agent";

/**
 * The GLOBAL fastagent credentials file (distinct from pi's `~/.pi`). The project-level default is
 * `<dir>/.fastagent/auth.json` (computed by the opener and by `fastagent login`); this is only the
 * `loginFlow()` PROGRAMMATIC fallback (when a caller omits `authPath`) and the path to point
 * `--auth-path`/`FASTAGENT_AUTH_PATH` at to deliberately share ONE credential file across projects
 * (safe — one file, one lock-serialized refresh lifecycle). The `fastagent login` CLI is project-
 * level by default, never this.
 */
export const GLOBAL_AUTH_PATH = join(homedir(), ".fastagent", "auth.json");

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

/**
 * Parse the credentials JSON for a WRITE: a corrupt file must THROW — serializing `{}` over it would
 * wipe every other provider's credentials. The throw aborts the locked write, leaving the file intact.
 */
function parseForWrite(raw: string | undefined, where: string): Creds {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Creds;
  } catch {
    throw new Error(`refusing to overwrite corrupt auth file ${where} — fix or remove it`);
  }
}

/** A read-write `CredentialStore` backed by the given credentials file (default {@link GLOBAL_AUTH_PATH};
 *  the directory opener passes the project-level `<dir>/.fastagent/auth.json`). */
export function fastagentCredentialStore(
  authPath: string = GLOBAL_AUTH_PATH,
  options: FastagentAuthOptions = {},
): CredentialStore {
  const warn = options.warn ?? ((message: string) => log.warn(message));
  const backend = new FileAuthStorageBackend(authPath);

  return {
    async read(providerId) {
      // UNLOCKED hot path: the only race is a sub-millisecond in-place write during an OAuth rotation,
      // which can yield an empty/partial file. Re-read a few times before concluding it is corrupt;
      // a valid `{}` (provider absent) returns immediately, so a not-configured read costs nothing.
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
        if (attempt < 2) await sleep(2);
      }
      warn(`[fastagent] corrupt auth file ${authPath} — fix or remove it`);
      return undefined;
    },
    modify(providerId, fn) {
      return backend.withLockAsync(async (current) => {
        const creds = parseForWrite(current, authPath); // corrupt → throw → no clobber
        const next = await fn(pick(creds, providerId));
        if (next === undefined) return { result: pick(creds, providerId) }; // unchanged: no write
        creds[providerId] = next;
        return { result: next, next: `${JSON.stringify(creds, null, 2)}\n` };
      });
    },
    async delete(providerId) {
      // No-op when nothing is stored: do NOT take the lock (which would create the file via the
      // backend's ensureFileExists) on a machine that never stored this provider.
      if (!existsSync(authPath)) return;
      await backend.withLockAsync(async (current) => {
        const creds = parseForWrite(current, authPath);
        if (!(providerId in creds)) return { result: undefined }; // absent: no write
        delete creds[providerId];
        return { result: undefined, next: `${JSON.stringify(creds, null, 2)}\n` };
      });
    },
  };
}
