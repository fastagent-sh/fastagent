/**
 * Auth for the pi harness: a read-WRITE {@link CredentialStore} over a fastagent credentials file, consumed by the
 * `Models` collection (models.ts), and which of those files an agent reads. The write path refuses to overwrite a
 * corrupt file, so a torn read never clobbers the other providers' credentials.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { globalHome, SECRETS_DIRNAME, resolveOverridePath, resolveSecretsDir } from "../../paths.ts";
import { log } from "../../log.ts";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { withLockedFile } from "./locked-file.ts";

/**
 * The GLOBAL fastagent credentials file (distinct from pi's `~/.pi`), under the user-global machinery home
 * `~/.fastagent/`.
 */
export const GLOBAL_AUTH_PATH = join(globalHome(), SECRETS_DIRNAME, "auth.json");

export interface FastagentAuthOptions {
  /** Sink for non-fatal auth anomalies (unreadable/corrupt file). */
  warn?: (message: string) => void;
}

type Creds = Record<string, Credential>;

/**
 * Where a caller's model credentials live: fastagent's JSON file (`authPath`, or the default layers when neither is
 * given), or a {@link CredentialStore} the caller owns (an OS keychain, Electron `safeStorage`). A supplied store
 * replaces the FILES: none is read or written, and no global layer applies. Env variables and `models.json` keys still
 * apply, below a stored credential, exactly as with `authPath`. The store owns what the file store does
 * for its file: `modify` for one provider must run one at a time, because an OAuth refresh happens inside it and a
 * rotated refresh token must never be used twice; and a store it cannot parse must not be answered as empty, or the
 * next write replaces every provider's credential.
 */
export interface CredentialSourceOptions {
  /** fastagent's credentials file. Mutually exclusive with {@link credentialStore}. */
  authPath?: string;
  /** The caller's own store, read and written instead of any file. Mutually exclusive with {@link authPath}. */
  credentialStore?: CredentialStore;
}

/** The one refusal for a caller that names both sources: silently preferring one would hide the other's mistake. */
export function assertOneCredentialSource(options: CredentialSourceOptions): void {
  if (options.authPath !== undefined && options.credentialStore !== undefined) {
    throw new Error("pass authPath or credentialStore, not both: a supplied store replaces the credentials file");
  }
}

/** A credential store over fastagent's files, which can also say which file a provider belongs to. */
export type FastagentCredentialStore = CredentialStore & {
  /**
   * The file this store reads a provider from and writes its refresh to: where it already is, else the primary. The
   * one answer to "which file do I edit", so a report naming a file cannot disagree with the store that reads it.
   */
  layerOf(providerId: string): Promise<string>;
};

/** A valid stored credential, or undefined — a foreign/old entry reads as not-configured, not a crash. */
function pick(creds: Creds, providerId: string): Credential | undefined {
  const cred = creds[providerId];
  return cred && (cred.type === "oauth" || cred.type === "api_key") ? cred : undefined;
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
 * opener passes the project-level `<root>/.secrets/auth.json`), optionally falling back to a second file. A path is
 * read like `FASTAGENT_AUTH_PATH` (`~` is the home directory, a relative one resolves against the cwd), so every
 * caller that names a file names the same one.
 *
 * The fallback is PER PROVIDER, not per file: logging one provider into a project must not hide the others a person
 * already has globally. And the layer a credential was READ from is the layer its refresh is written back to —
 * anything else would conjure a second holder of the same OAuth grant, which is the failure this whole area exists
 * to avoid. A provider present in neither layer is new, and new credentials belong to the primary.
 *
 * The fallback also yields to `projectAuthenticates`: a provider the project authenticates some other way (an env key,
 * its own models.json) never reaches it — for reading, listing or writing back.
 */
export function fastagentCredentialStore(
  path?: string,
  options: FastagentAuthOptions & {
    fallbackPath?: string;
    /** Whether the project authenticates this provider without the fallback; then the fallback is not read for it. */
    projectAuthenticates?: (providerId: string) => Promise<boolean>;
  } = {},
): FastagentCredentialStore {
  const warn = options.warn ?? ((message: string) => log.warn(message));
  const authPath = resolveOverridePath(path) ?? GLOBAL_AUTH_PATH;
  const fallbackPath = resolveOverridePath(options.fallbackPath);
  const fallback = fallbackPath !== undefined && fallbackPath !== authPath ? fallbackPath : undefined;
  /** The fallback, when it may serve this provider at all. */
  const fallbackFor = async (providerId: string): Promise<string | undefined> =>
    fallback === undefined || (await options.projectAuthenticates?.(providerId)) ? undefined : fallback;
  /**
   * The file that owns this provider: where it already is, else the primary.
   *
   * Known ceiling: this read is UNLOCKED, so a concurrent `fastagent login` writing the same provider into the
   * primary between here and the lock below sends this refresh to the fallback instead — the one window in which the
   * "one grant, one copy" rule can be lost. Re-checking under the lock means locking both files in a fixed order;
   * worth it only if concurrent logins stop being a rounding error.
   */
  const owner = async (providerId: string): Promise<string> => {
    const second = await fallbackFor(providerId);
    if (second === undefined) return authPath;
    const primary = readCreds(authPath, warn);
    if (primary && pick(primary, providerId)) return authPath;
    const secondary = readCreds(second, warn);
    return secondary && pick(secondary, providerId) ? second : authPath;
  };

  return {
    layerOf: owner,
    async read(providerId) {
      const second = await fallbackFor(providerId);
      for (const path of second === undefined ? [authPath] : [authPath, second]) {
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
          if (path === fallback && (await fallbackFor(providerId)) === undefined) continue;
          if (cred && (cred.type === "oauth" || cred.type === "api_key"))
            infos.set(providerId, { providerId, type: cred.type });
        }
      }
      return [...infos.values()];
    },
    async modify(providerId, fn) {
      const path = await owner(providerId);
      return withLockedFile(path, async (current) => {
        const creds = parseForWrite(current, path); // corrupt → throw → no clobber
        const next = await fn(pick(creds, providerId));
        if (next === undefined) return { result: pick(creds, providerId) }; // unchanged: no write
        creds[providerId] = next;
        return { result: next, next: `${JSON.stringify(creds, null, 2)}\n` };
      });
    },
    async delete(providerId) {
      const path = await owner(providerId);
      // No-op when nothing is stored: do NOT take the lock (which would create the file) on a machine that never
      // stored this provider.
      if (!existsSync(path)) return;
      await withLockedFile(path, async (current) => {
        const creds = parseForWrite(current, path);
        if (!(providerId in creds)) return { result: undefined }; // absent: no write
        delete creds[providerId];
        return { result: undefined, next: `${JSON.stringify(creds, null, 2)}\n` };
      });
    },
  };
}

// ── Which files an agent reads ───────────────────────────────────────────────

/**
 * The auth-file override: the SDK's `authPath` option > `FASTAGENT_AUTH_PATH` env > undefined (then
 * `<secrets dir>/auth.json`). The CLI has no flag for it: a second spelling of one environment variable buys nothing,
 * and the variable is what a deployed container reads anyway.
 */
function resolveAuthPathOverride(flag: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  return resolveOverridePath(flag ?? env.FASTAGENT_AUTH_PATH);
}

/** The effective auth file for an agent: override if present, else `<secrets dir>/auth.json`. */
export function resolveAuthPath(dir: string, flag?: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolveAuthPathOverride(flag, env) ?? join(resolveSecretsDir(dir, env), "auth.json");
}

/**
 * Which credentials files an agent reads: `path` first, then, per provider, `fallback`. One value because it is one
 * decision, read through `agentModels` (agent-models.ts) by everything that reads an agent's credentials.
 */
export interface AuthLayers {
  path: string;
  fallback?: string;
}

/**
 * The {@link AuthLayers} an agent directory reads: `authPath` option > `FASTAGENT_AUTH_PATH` > its own file, and
 * behind it the user-global store, because a login is a PERSON on a machine and not a project — one `login -g` then
 * serves every agent here.
 *
 * No fallback when a path was named: "use this file" is an instruction, not a preference. BOTH knobs
 * {@link resolveAuthPath} reads count as that instruction, `FASTAGENT_SECRETS_DIR` included — it is what the
 * Fly/Railway/AgentCore artifacts set, and a deployed container must read its mounted credentials and nothing else
 * (the artifact is the truth).
 */
export function resolveAuthLayers(
  agentDir: string,
  authPath?: string,
  env: NodeJS.ProcessEnv = process.env,
): AuthLayers {
  const path = resolveAuthPath(agentDir, authPath, env);
  const named = resolveAuthPathOverride(authPath, env) ?? resolveOverridePath(env.FASTAGENT_SECRETS_DIR);
  return named === undefined ? { path, fallback: GLOBAL_AUTH_PATH } : { path };
}
