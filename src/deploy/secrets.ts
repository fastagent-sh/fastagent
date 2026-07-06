/**
 * The secret set a deployed agent needs, computed from the definition — host-neutral. WHAT secrets are
 * required (the model key when local auth is an env key + every discovered channel's secrets) is the
 * same on every target; only the SET command differs (`fly secrets import` vs `railway variables --set`).
 * The runbooks list these NAMES; `--run` (per host) reads their VALUES from the local env.
 */
import { type ChannelKind, channelSetup } from "../scaffold/add-channel.ts";

/**
 * Is this local auth source an env-var API key (→ becomes a deploy secret) vs OAuth / stored / none?
 * Positive match on the UPPER_SNAKE env-var naming shape, NOT a negative exclude of today's sentinel
 * labels: a new non-env `AuthResult.source` (e.g. `keychain`) then degrades to guidance, never a fake
 * `keychain=<value>` secret — the two modules don't couple through an exhaustive string list.
 */
export function isEnvKey(source: string | undefined): source is string {
  return source !== undefined && /^[A-Z][A-Z0-9_]*$/.test(source);
}

/**
 * The required secret NAMES + hints for a runbook: the model key (when local auth is an env key) plus
 * every discovered channel's secrets. An OAuth/stored login has no env key here — it carries as
 * `FASTAGENT_AUTH_SEED` on the `--run` path (see each host's run module), not as a named runbook secret.
 */
export function requiredSecrets(
  modelAuth: string | undefined,
  channels: ChannelKind[],
): { name: string; hint: string }[] {
  const secrets: { name: string; hint: string }[] = [];
  if (isEnvKey(modelAuth)) secrets.push({ name: modelAuth, hint: "your model provider key" });
  for (const kind of channels) {
    for (const e of channelSetup(kind).env) secrets.push({ name: e.name, hint: e.hint });
  }
  return secrets;
}
