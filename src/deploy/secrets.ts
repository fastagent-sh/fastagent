/**
 * The secret set a deployed agent needs, computed from the definition — host-neutral. Required values
 * gate every target; optional channel values travel only when configured. Only the SET command differs
 * (`fly secrets import` vs `railway variables set`). The runbooks list both classes; `--run` reads local values.
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
 * Secret NAMES + hints for a runbook: the model key (when local auth is an env key), discovered channel
 * secrets, and config extras. Channel metadata keeps optional values visible without presenting them as
 * deployment prerequisites. An OAuth/stored login has no env key here — it carries as
 * `FASTAGENT_AUTH_SEED` on the `--run` path (see each host's run module), not as a named runbook secret.
 */
export function deploymentSecrets(
  modelAuth: string | undefined,
  channels: ChannelKind[],
  extraSecrets: string[] = [],
  longConnectionChannels: string[] = [],
): { name: string; hint: string; required: boolean }[] {
  const secrets: { name: string; hint: string; required: boolean }[] = [];
  if (isEnvKey(modelAuth)) secrets.push({ name: modelAuth, hint: "your model provider key", required: true });
  for (const kind of channels) {
    const setupMode = longConnectionChannels.includes(kind) ? "websocket" : "webhook";
    for (const e of channelSetup(kind, setupMode).env) {
      secrets.push({ name: e.name, hint: e.hint, required: e.required });
    }
  }
  // Dedup: a name already covered by the model key / a channel secret must not appear twice in the runbook.
  for (const name of extraSecrets) {
    if (!secrets.some((s) => s.name === name)) {
      secrets.push({ name, hint: "declared in fastagent.config deploy.secrets", required: true });
    }
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
 * which a silent mint never surfaces) and would rotate every run (breaking idempotency). An absent
 * required value enters `missingSecrets`; an absent optional value is simply omitted.
 */
export function assembleSecrets(input: {
  modelAuth: string | undefined;
  authFile: Buffer | undefined;
  channels: ChannelKind[];
  longConnectionChannels?: string[];
  /** Extra secret env-var names from `fastagent.config` deploy.secrets — carried like channel secrets. */
  extraSecrets?: string[];
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
    const setupMode = input.longConnectionChannels?.includes(kind) ? "websocket" : "webhook";
    for (const e of channelSetup(kind, setupMode).env) {
      const v = input.env[e.name];
      if (v)
        secrets[e.name] = v; // optional channel values travel when configured
      else if (e.required) {
        missingSecrets.push(e.name); // operator-provided (in .env); a human-shared secret can't be minted
      }
    }
  }
  // Slack bot-token rotation is an all-or-nothing credential bundle. Its fields remain optional so a
  // manually configured long-lived token works, but a partial bundle must gate before the container
  // reaches slackChannel construction.
  if (input.channels.includes("slack")) {
    const rotation = [
      "SLACK_BOT_REFRESH_TOKEN",
      "SLACK_BOT_TOKEN_EXPIRES_AT",
      "SLACK_CLIENT_ID",
      "SLACK_CLIENT_SECRET",
    ];
    if (rotation.some((name) => !!input.env[name])) {
      for (const name of rotation) {
        if (!input.env[name] && !missingSecrets.includes(name)) missingSecrets.push(name);
      }
    }
  }

  for (const name of input.extraSecrets ?? []) {
    if (name in secrets || missingSecrets.includes(name)) continue; // already covered by model/channel — no dup
    const v = input.env[name];
    if (v) secrets[name] = v;
    else missingSecrets.push(name); // declared in config but no local value — same .env remediation
  }
  return { secrets, missingSecrets, needsModelCredential };
}
