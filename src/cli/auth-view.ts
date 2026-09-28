/** CLI presenter for the auth-status line `reportAuth` prints (invoke/dev/start). */

/** A stored credential as `reportAuth` needs it: just its kind, for the status line. */
export interface StoredCredentialInfo {
  type: string;
}

/**
 * Format the auth status for `spec`'s provider. `deployed`: this process is a deployed box, which logs in from the
 * owner's workspace (`fastagent login --deployment`), never by a login run on it by hand.
 */
export function formatAuthReport(
  provider: string,
  authPath: string,
  source: string | undefined,
  stored: StoredCredentialInfo | undefined,
  deployed = false,
): { line: string; warn?: string } {
  if (source !== undefined) return { line: `auth:   ${source} (${provider}) — ${authPath}` };
  const login = deployed
    ? "`fastagent login --deployment` from the workspace this was deployed from"
    : "`fastagent login`";
  if (stored) {
    return {
      line: `auth:   stored ${provider} ${stored.type}, expired/unusable — ${authPath}`,
      warn: `the "${provider}" login is expired or unusable — run ${login} to replace it`,
    };
  }
  return {
    line: `auth:   (none found) — ${authPath}`,
    warn: `no credentials for "${provider}" — run ${login}, or set the provider's API key in ${deployed ? "the deployment's value file" : ".env"}; invokes will fail until then`,
  };
}
