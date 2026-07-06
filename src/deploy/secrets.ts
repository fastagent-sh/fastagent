/**
 * The secret set a deployed agent needs, computed from the definition — host-neutral. WHAT secrets are
 * required (the model key when local auth is an env key + every discovered channel's secrets) is the
 * same on every target; only the SET command differs (`fly secrets import` vs `railway variables set`).
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

/**
 * Assemble the secret VALUES a `--run` deploy sets on the host, from the local credential + channels —
 * pure, host-neutral (Fly sets them via `fly secrets import`, Railway via `railway variables set`), so
 * the security-sensitive key wiring is testable once. The model credential travels one of two ways: an
 * env-key auth as its own secret (value from `env`), OR an OAuth/stored login (no plaintext key) as
 * `FASTAGENT_AUTH_SEED` (base64 auth.json) which `start` materializes on first boot. `needsModelCredential`
 * (neither present) is a DISTINCT signal: its remediation is `fastagent login`, not the `.env` one that
 * `missingSecrets` (real secret NAMES with no value) carries.
 *
 * Channel secrets come from the local env only — NEVER minted. A random mint would be wrong for a
 * human-shared secret (github's webhook secret must match the value the operator enters in the repo,
 * which a silent mint never surfaces) and would rotate every run (breaking idempotency). Absent →
 * `missingSecrets`, same as the plain runbook's operator-filled placeholders.
 */
export function assembleSecrets(input: {
  modelAuth: string | undefined;
  authFile: Buffer | undefined;
  channels: ChannelKind[];
  env: NodeJS.ProcessEnv;
}): {
  secrets: Record<string, string>;
  missingSecrets: string[];
  needsModelCredential: boolean;
} {
  const secrets: Record<string, string> = {};
  const missingSecrets: string[] = [];
  let needsModelCredential = false;

  if (isEnvKey(input.modelAuth)) {
    const v = input.env[input.modelAuth];
    if (v) secrets[input.modelAuth] = v;
    else missingSecrets.push(input.modelAuth); // an env-key name with no value — `.env` remediation fits
  } else if (input.authFile) {
    secrets.FASTAGENT_AUTH_SEED = input.authFile.toString("base64");
  } else {
    needsModelCredential = true; // no env key, no auth.json — `fastagent login` remediation
  }

  for (const kind of input.channels) {
    for (const e of channelSetup(kind).env) {
      const v = input.env[e.name];
      if (v) secrets[e.name] = v;
      else missingSecrets.push(e.name); // operator-provided (in .env); a human-shared secret can't be minted
    }
  }
  return { secrets, missingSecrets, needsModelCredential };
}
