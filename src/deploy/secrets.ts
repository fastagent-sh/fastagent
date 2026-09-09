/** The secret set a deployed agent needs, computed from the definition — host-neutral. */
import { CONTROL_TOKEN_ENV } from "../channels/control.ts";
import type { DeclaredChannel } from "../channels/discover.ts";
import { CHANNEL_KINDS, type ChannelKind, channelSetup } from "../scaffold/add-channel.ts";

/** The declared channels this tool has setup metadata for. */
function firstPartyChannels(
  channels: readonly DeclaredChannel[],
): { kind: ChannelKind; ingress: DeclaredChannel["ingress"] }[] {
  return channels.flatMap((channel) =>
    (CHANNEL_KINDS as string[]).includes(channel.name)
      ? [{ kind: channel.name as ChannelKind, ingress: channel.ingress }]
      : [],
  );
}

/** Is this local auth source an env-var API key (→ becomes a deploy secret) vs OAuth / stored / none? */
export function isEnvKey(source: string | undefined): source is string {
  return source !== undefined && /^[A-Z][A-Z0-9_]*$/.test(source);
}

/**
 * Secret NAMES + hints for a runbook: the model key (when local auth is an env key), discovered channel secrets, and
 * config extras.
 */
export function deploymentSecrets(
  modelAuth: string | undefined,
  channels: readonly DeclaredChannel[],
  extraSecrets: string[] = [],
): { name: string; hint: string; required: boolean }[] {
  const secrets: { name: string; hint: string; required: boolean }[] = [];
  if (isEnvKey(modelAuth)) secrets.push({ name: modelAuth, hint: "your model provider key", required: true });
  for (const { kind, ingress } of firstPartyChannels(channels)) {
    for (const e of channelSetup(kind, ingress === "long-connection" ? "websocket" : "webhook").env) {
      secrets.push({ name: e.name, hint: e.hint, required: e.required });
    }
  }
  // Dedup: a name already covered by the model key / a channel secret must not appear twice in the runbook.
  for (const name of extraSecrets) {
    if (!secrets.some((s) => s.name === name)) {
      const control = name === CONTROL_TOKEN_ENV;
      secrets.push({
        name,
        hint: control
          ? "the /control/* bearer token — mint one (uuidgen) and give the same value to callers"
          : "declared in fastagent.config deploy.secrets",
        // OPTIONAL, unlike every other extra: unset, the box mints a per-boot token and still serves, and every host
        // with a shell can read it back out of control.json.
        required: !control,
      });
    }
  }
  return secrets;
}

/**
 * Assemble the secret VALUES a `--run` deploy sets on the host, from the local credential + channels. Channel secrets
 * come from the local env only — NEVER minted here.
 */
export function assembleSecrets(input: {
  modelAuth: string | undefined;
  /**
   * The definition carries the model key itself (a models.json literal `apiKey` / `!command`): there is no value to
   * carry and no gate to raise.
   */
  modelKeyInDefinition?: boolean;
  authFile: Buffer | undefined;
  channels: readonly DeclaredChannel[];
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
  } else if (input.modelKeyInDefinition) {
    // The definition authenticates itself (models.json literal key, or a command run on the host), so it travels in
    // the image with everything else.
  } else {
    needsModelCredential = true; // no env key, no auth.json — `fastagent login` remediation
  }

  for (const { kind, ingress } of firstPartyChannels(input.channels)) {
    for (const e of channelSetup(kind, ingress === "long-connection" ? "websocket" : "webhook").env) {
      const v = input.env[e.name];
      if (v)
        secrets[e.name] = v; // optional channel values travel when configured
      else if (e.required) {
        missingSecrets.push(e.name); // operator-provided (in .env); a human-shared secret can't be minted
      }
    }
  }
  for (const name of input.extraSecrets ?? []) {
    if (name in secrets || missingSecrets.includes(name)) continue; // already covered by model/channel — no dup
    const v = input.env[name];
    if (v) secrets[name] = v;
    // The control token is CARRIED, never gated.
    else if (name !== CONTROL_TOKEN_ENV) missingSecrets.push(name);
  }
  return { secrets, missingSecrets, needsModelCredential };
}

/** The bytes to seed to the auth file, or undefined to leave it alone. */
export function authSeedBytes(seed: string | undefined, fileExists: boolean): Buffer | undefined {
  return !seed || fileExists ? undefined : Buffer.from(seed, "base64");
}

/**
 * Collect the (possibly CHUNKED) auth seed from the environment: `FASTAGENT_AUTH_SEED` plus numbered continuations
 * (`_2`, `_3`, …) concatenated in order.
 */
export function collectAuthSeed(env: NodeJS.ProcessEnv): string | undefined {
  const first = env.FASTAGENT_AUTH_SEED;
  if (!first) return undefined;
  let seed = first;
  for (let i = 2; ; i++) {
    const part = env[`FASTAGENT_AUTH_SEED_${i}`];
    if (!part) break;
    seed += part;
  }
  return seed;
}
