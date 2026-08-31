/**
 * The secret set a deployed agent needs, computed from the definition — host-neutral. Required values
 * gate every target; optional channel values travel only when configured. Only the SET command differs
 * (`fly secrets import` vs `railway variables set`). The runbooks list both classes; `--run` reads local values.
 *
 * Both DIRECTIONS of the credential carry live here: the deploy-time assembly below, and the boot-time
 * seed read at the bottom. They were split across a host driver (`fly/run.ts`), which left `start`
 * — a serving path that deploys nothing, on Fly or anywhere — importing from it to boot a container.
 */
import { CONTROL_TOKEN_ENV } from "../channels/control.ts";
import type { DeclaredChannel } from "../channels/discover.ts";
import { CHANNEL_KINDS, type ChannelKind, channelSetup } from "../scaffold/add-channel.ts";

/** The declared channels this tool has setup metadata for. A custom channel carries its own secrets;
 *  nothing here can name them, and guessing would print a runbook line no one can act on. */
function firstPartyChannels(
  channels: readonly DeclaredChannel[],
): { kind: ChannelKind; ingress: DeclaredChannel["ingress"] }[] {
  return channels.flatMap((channel) =>
    (CHANNEL_KINDS as string[]).includes(channel.name)
      ? [{ kind: channel.name as ChannelKind, ingress: channel.ingress }]
      : [],
  );
}

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
        // OPTIONAL, unlike every other extra: unset, the box mints a per-boot token and still serves,
        // and every host with a shell can read it back out of control.json. Gating would stop deploys
        // that work today to enforce a convenience — the pre-flight warning is where that argument
        // belongs.
        required: !control,
      });
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
  /** The definition carries the model key itself (a models.json literal `apiKey` / `!command`): there is
   *  no value to carry and no gate to raise — see {@link modelCredentialCarry}. */
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
    // The definition authenticates itself (models.json literal key, or a command run on the host), so it
    // travels in the image with everything else. Gating here would be the worst kind of wrong: both
    // remedies we print are impossible for such an agent — `fastagent login` has no flow for a custom
    // provider, and there is no provider env key to set.
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
  // Slack bot-token rotation is an all-or-nothing credential bundle. Its fields remain optional so a
  // manually configured long-lived token works, but a partial bundle must gate before the container
  // reaches slackChannel construction.
  if (input.channels.some((channel) => channel.name === "slack")) {
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
    // The control token is CARRIED, never gated — see {@link deploymentSecrets}: unset, the box mints
    // one and serves; every other extra is declared as needed, so its absence is a stop.
    else if (name !== CONTROL_TOKEN_ENV) missingSecrets.push(name);
  }
  return { secrets, missingSecrets, needsModelCredential };
}

/**
 * The bytes to seed to the auth file, or undefined to leave it alone — the pure core of `start`'s
 * FASTAGENT_AUTH_SEED materialization (the read side of {@link assembleSecrets}'s carry). ABSENT-ONLY
 * by design: a present file (a refreshed volume copy) is never overwritten by the stale seed, so a box
 * that ran its own OAuth refresh is not rolled back.
 */
export function authSeedBytes(seed: string | undefined, fileExists: boolean): Buffer | undefined {
  return !seed || fileExists ? undefined : Buffer.from(seed, "base64");
}

/**
 * Collect the (possibly CHUNKED) auth seed from the environment: `FASTAGENT_AUTH_SEED` plus numbered
 * continuations (`_2`, `_3`, …) concatenated in order. Hosts whose env values carry a small max
 * length (AgentCore: 2048 chars — a real OAuth auth.json's base64 exceeds it) split the seed across
 * them at deploy time; single-var hosts (Fly/Railway) never set a continuation and are unchanged.
 * Collection stops at the first absent/empty continuation — the writer fills them contiguously.
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
