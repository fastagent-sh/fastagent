/** The secret set a deployed agent needs, computed from the definition — host-neutral. */
import { CONTROL_TOKEN_ENV } from "../channels/control.ts";
import { type DeclaredSecret, dedupeSecrets } from "../declared-secrets.ts";
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
 * everything the definition declared (src/declared-secrets.ts) — each hinted by the file that declared it, since the
 * reader is the person who must find the value.
 */
export function deploymentSecrets(
  modelAuth: string | undefined,
  channels: readonly DeclaredChannel[],
  extraSecrets: readonly DeclaredSecret[] = [],
): { name: string; hint: string; required: boolean }[] {
  const secrets: { name: string; hint: string; required: boolean }[] = [];
  if (isEnvKey(modelAuth)) secrets.push({ name: modelAuth, hint: "your model provider key", required: true });
  for (const { kind, ingress } of firstPartyChannels(channels)) {
    for (const e of channelSetup(kind, ingress === "long-connection" ? "websocket" : "webhook").env) {
      secrets.push({ name: e.name, hint: e.hint, required: e.required });
    }
  }
  // Dedup: a name already covered by the model key / a channel secret must not appear twice in the
  // runbook, and two tools declaring the same name are one secret.
  for (const { name, source } of dedupeSecrets(extraSecrets)) {
    if (!secrets.some((s) => s.name === name)) {
      const control = name === CONTROL_TOKEN_ENV;
      secrets.push({
        name,
        // The SOURCE, not a fixed sentence: a declared name now comes from wherever it was declared
        // (a tool, a schedule, the config list), and the runbook's reader is the person who has to
        // find the value — pointing at the wrong file is worse than pointing at none.
        hint: control
          ? "the /control/* bearer token — mint one (uuidgen) and give the same value to callers"
          : `required by ${source}`,
        // OPTIONAL, unlike every other extra: unset, the box mints a per-boot token and still serves, and every host
        // with a shell can read it back out of control.json.
        required: !control,
      });
    }
  }
  return secrets;
}

/**
 * Assemble the VALUES a `--run` deploy sets on the host, from the deployed environment's declaration + the local
 * credential. Never minted here.
 *
 * `values` is the selected value file, read as data — **the environment running `deploy` is not a source**. A
 * deployment must be reproducible from what it carries, and a variable that happens to be exported on the builder is
 * written down nowhere. It is the same rule the model already follows, and the same line the industry draws by what
 * a tool configures: dotenv and Compose let the shell win because they configure THIS process, Terraform checks
 * `TF_VAR_*` last because it declares a remote object, and Kamal 2 stopped loading `.env` into the environment
 * altogether. CI supplies values by writing the file before running the command.
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
  /** Everything the definition declared it needs — `deploy.secrets` plus every tool/schedule
   *  declaration — carried like channel secrets. */
  extraSecrets?: readonly DeclaredSecret[];
  /** The selected value file's contents (`loadEnvValues`). The ONLY source of operator-supplied values. */
  values: ReadonlyMap<string, string>;
}): {
  secrets: Record<string, string>;
  missingSecrets: string[];
  needsModelCredential: boolean;
} {
  const secrets: Record<string, string> = {};
  const missingSecrets: string[] = [];
  let needsModelCredential = false;

  if (isEnvKey(input.modelAuth)) {
    const v = input.values.get(input.modelAuth);
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
      const v = input.values.get(e.name);
      if (v)
        secrets[e.name] = v; // optional channel values travel when configured
      else if (e.required) {
        missingSecrets.push(e.name); // operator-provided (in .env); a human-shared secret can't be minted
      }
    }
  }
  for (const { name } of dedupeSecrets(input.extraSecrets ?? [])) {
    if (name in secrets || missingSecrets.includes(name)) continue; // already covered by model/channel — no dup
    const v = input.values.get(name);
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
