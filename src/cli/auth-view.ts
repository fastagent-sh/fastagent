/** CLI presenter for the auth-status line `reportAuth` prints (invoke/dev/start). */

/**
 * Format the auth status for a provider, from `AgentModels.authStatus`'s answer. `deployed`: this process is a
 * deployed box, which logs in from the owner's workspace (`fastagent login --deployment`), never by a login run on it
 * by hand.
 */
export function formatAuthReport(status: {
  provider: string;
  path: string;
  source?: string;
  /** Why resolving the credential failed, when it did: said, because "expired" is only one of the reasons. */
  error?: string;
  stored?: string;
  shadowed?: string;
  deployed?: boolean;
}): { line: string; warn?: string } {
  const { provider, path, source, error, stored, shadowed, deployed = false } = status;
  const because = error === undefined ? "" : ` (${error})`;
  const login = (name: string) =>
    deployed ? `\`${name} --deployment\` from the workspace this was deployed from` : `\`${name}\``;
  if (source !== undefined) {
    const line = `auth:   ${source} (${provider}) — ${path}`;
    if (shadowed === undefined) return { line };
    // A stored credential owns its provider in pi, so a key added to the environment later is silently unused.
    return {
      line,
      warn:
        `${shadowed} is set but unused: the stored ${provider} ${stored} credential in ${path} outranks it. To run ` +
        `on ${shadowed}, log in with it instead: ${login(`fastagent login ${provider}`)}, choosing "API key"`,
    };
  }
  if (stored) {
    return {
      line: `auth:   stored ${provider} ${stored}, expired/unusable — ${path}`,
      warn: `the "${provider}" login is expired or unusable${because} — run ${login("fastagent login")} to replace it`,
    };
  }
  return {
    line: `auth:   (none found) — ${path}`,
    warn: `no credentials for "${provider}"${because} — run ${login("fastagent login")}, or set the provider's API key in ${deployed ? "the deployment's value file" : ".env"}; invokes will fail until then`,
  };
}
