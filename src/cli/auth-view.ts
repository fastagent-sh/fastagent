/** CLI presenter for the auth-status line `reportAuth` prints (invoke/dev/start). */

/** A stored credential as `reportAuth` needs it: just its kind, for the status line. */
export interface StoredCredentialInfo {
  type: string;
}

/** Format the auth status for `spec`'s provider. */
export function formatAuthReport(
  provider: string,
  authPath: string,
  source: string | undefined,
  stored: StoredCredentialInfo | undefined,
): { line: string; warn?: string } {
  if (source !== undefined) return { line: `auth:   ${source} (${provider}) — ${authPath}` };
  if (stored) {
    return {
      line: `auth:   stored ${provider} ${stored.type}, expired/unusable — ${authPath}`,
      warn: `the "${provider}" login is expired or unusable — run \`fastagent login\` to refresh it`,
    };
  }
  return {
    line: `auth:   (none found) — ${authPath}`,
    warn: `no credentials for "${provider}" — run \`fastagent login\`, or set the provider's API key in .env; invokes will fail until then`,
  };
}
