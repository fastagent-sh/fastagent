/**
 * CLI presenter for the auth-status line `reportAuth` prints (invoke/dev/start). Kept out of cli.ts —
 * which self-executes on import — so the expired-vs-missing DECISION is unit-testable without a real
 * credential round-trip, mirroring cli-models.ts.
 */

/** A stored credential as `reportAuth` needs it: just its kind, for the status line. */
export interface StoredCredentialInfo {
  type: string;
}

/**
 * Format the auth status for `spec`'s provider. `source` is {@link probeAuthSource}'s label (an env-var
 * name, "OAuth", a stored-key label) or undefined when nothing currently SATISFIES auth. Undefined has
 * TWO causes probeAuthSource can't distinguish (it swallows the throw): nothing stored, OR a credential
 * that IS stored but couldn't be made usable (an expired/revoked OAuth whose refresh failed). `stored`
 * — a refresh-FREE store read the caller does only in that case — tells them apart, so an expired login
 * reports "expired/unusable → `fastagent login`" instead of a misleading "(none found)" (which would then
 * be contradicted by the actual "OAuth refresh failed"). A malformed/unreadable store also reads as
 * undefined `stored` and lands in "(none found)" — but the store's own read warns about the corrupt file,
 * so the real signal is surfaced there; this line stays about credential PRESENCE.
 */
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
