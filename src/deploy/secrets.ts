/**
 * The environment a deployed agent runs with — host-neutral.
 *
 * The value file (`.secrets/.env`) IS the deployed environment: every variable in it travels, on every host. What the
 * definition declares (`defineTool`/`defineChannel`/`defineRoutine({ secrets })`, plus the model's env key) only says
 * which of those must have a value, so a missing one stops a deploy before its first side effect instead of a boot.
 */
import { type DeclaredSecret, dedupeSecrets } from "../declared-secrets.ts";

/** Is this local auth source an env-var API key (→ becomes a deploy secret) vs OAuth / stored / none? */
export function isEnvKey(source: string | undefined): source is string {
  return source !== undefined && /^[A-Z][A-Z0-9_]*$/.test(source);
}

/**
 * Names a deployment sets on the box itself. The value file's copy of one describes THIS machine (a local state path,
 * a port) or rides another carrier (the model rides the release manifest), so it never travels.
 */
const DEPLOY_OWNED = new Set([
  "PORT",
  "FASTAGENT_AGENT",
  "FASTAGENT_MODEL",
  "FASTAGENT_STATE_DIR",
  "FASTAGENT_SECRETS_DIR",
  "FASTAGENT_AUTH_PATH",
  "FASTAGENT_RELEASE_FILE",
  "FASTAGENT_STORAGE_DIR",
  "FASTAGENT_AGENTCORE",
  "FASTAGENT_INGRESS_SECRET",
  "FASTAGENT_WAKE_SECRET",
  "FASTAGENT_DEV_WORKER",
]);

/** Is `name` one the deployment sets itself (see {@link DEPLOY_OWNED}), including the chunked carriers? */
function isDeployOwned(name: string): boolean {
  return DEPLOY_OWNED.has(name) || /^FASTAGENT_(AUTH_SEED|ENV)(_\d+)?$/.test(name);
}

/** The value-file variables that travel: everything with a value that the deployment does not set itself. */
function carriedValues(values: ReadonlyMap<string, string>): Record<string, string> {
  const carried: Record<string, string> = {};
  for (const [name, value] of values) if (value && !isDeployOwned(name)) carried[name] = value;
  return carried;
}

/** One variable a runbook tells the operator to set, and where to look for its value. */
export interface DeploymentSecret {
  name: string;
  hint: string;
}

/**
 * What a runbook lists: the names that must have a value (the model's env key, every declaration — hinted by the file
 * that declared it) and then every other variable the value file carries.
 */
export function deploymentSecrets(
  modelAuth: string | undefined,
  declared: readonly DeclaredSecret[],
  values: ReadonlyMap<string, string>,
  valueFile: string,
): DeploymentSecret[] {
  const secrets: DeploymentSecret[] = [];
  const add = (name: string, hint: string) => {
    if (!secrets.some((s) => s.name === name)) secrets.push({ name, hint });
  };
  if (isEnvKey(modelAuth)) add(modelAuth, "your model provider key");
  for (const { name, source } of dedupeSecrets(declared)) add(name, `required by ${source}`);
  for (const name of Object.keys(carriedValues(values))) add(name, `from ${valueFile}`);
  return secrets;
}

/**
 * Assemble the VALUES a `--run` deploy sets on the host: every variable the value file carries, plus the local
 * credential. Never minted here.
 *
 * `values` is the selected value file, read as data — **the environment running `deploy` is not a source**. A
 * deployment must be reproducible from what it carries, and a variable that happens to be exported on the builder is
 * written down nowhere. CI supplies values by writing the file before running the command.
 */
export function assembleSecrets(input: {
  modelAuth: string | undefined;
  /**
   * The definition carries the model key itself (a models.json literal `apiKey` / `!command`): there is no value to
   * carry and no gate to raise.
   */
  modelKeyInDefinition?: boolean;
  authFile: Buffer | undefined;
  /** Every name the definition declared it needs — what must have a value. */
  declared?: readonly DeclaredSecret[];
  /** The selected value file's contents (`loadEnvValues`). The ONLY source of operator-supplied values. */
  values: ReadonlyMap<string, string>;
}): {
  secrets: Record<string, string>;
  missingSecrets: string[];
  needsModelCredential: boolean;
} {
  const secrets = carriedValues(input.values);
  const missingSecrets: string[] = [];
  let needsModelCredential = false;

  if (isEnvKey(input.modelAuth)) {
    if (!secrets[input.modelAuth]) missingSecrets.push(input.modelAuth); // `.env` remediation fits
  } else if (input.authFile) {
    secrets.FASTAGENT_AUTH_SEED = input.authFile.toString("base64");
  } else if (input.modelKeyInDefinition) {
    // The definition authenticates itself (models.json literal key, or a command run on the host), so it travels in
    // the image with everything else.
  } else {
    needsModelCredential = true; // no env key, no auth.json — `fastagent login` remediation
  }
  for (const { name } of dedupeSecrets(input.declared ?? [])) {
    if (!secrets[name] && !missingSecrets.includes(name)) missingSecrets.push(name);
  }
  return { secrets, missingSecrets, needsModelCredential };
}

/**
 * The ONE refusal for declared names the deployed environment does not supply a value for — every host reaches it
 * before its first side effect. Host-neutral because the reason is: the value file IS the deployed environment, so a
 * name missing from it is missing from the deployment, whatever platform receives it.
 */
export function missingValuesGate(missing: readonly string[], valueFile: string): string | undefined {
  if (missing.length === 0) return undefined;
  return (
    `no value for: ${missing.join(", ")} — the deployed environment is declared by ${valueFile}, and this deploy ` +
    `reads only that file (exporting the variable here does not reach the deployment). Add them there and re-run`
  );
}

/** The bytes to seed to the auth file, or undefined to leave it alone. */
export function authSeedBytes(seed: string | undefined, fileExists: boolean): Buffer | undefined {
  return !seed || fileExists ? undefined : Buffer.from(seed, "base64");
}

/**
 * Collect a (possibly CHUNKED) carrier from the environment: `<name>` plus numbered continuations (`_2`, `_3`, …)
 * concatenated in order. A host whose env values have a length cap splits a long value this way.
 */
function collectChunked(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const first = env[name];
  if (!first) return undefined;
  let value = first;
  for (let i = 2; ; i++) {
    const part = env[`${name}_${i}`];
    if (!part) break;
    value += part;
  }
  return value;
}

/** `FASTAGENT_AUTH_SEED` (+ `_2`, …): the base64 auth.json a deploy carries. */
export function collectAuthSeed(env: NodeJS.ProcessEnv): string | undefined {
  return collectChunked(env, "FASTAGENT_AUTH_SEED");
}

/**
 * `FASTAGENT_ENV` (+ `_2`, …): the carried variables as ONE base64 JSON object, for a host whose deployment artifact
 * must not depend on which names the value file holds (AgentCore's template is committed and gated on drift). The
 * inverse of {@link encodeCarriedEnv}.
 */
function collectCarriedEnv(env: NodeJS.ProcessEnv): Record<string, string> | undefined {
  const encoded = collectChunked(env, "FASTAGENT_ENV");
  if (encoded === undefined) return undefined;
  const parsed: unknown = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("FASTAGENT_ENV is not an object of variables — redeploy to regenerate it");
  }
  const carried: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value !== "string")
      throw new Error(`FASTAGENT_ENV: ${name} is not a string — redeploy to regenerate it`);
    carried[name] = value;
  }
  return carried;
}

/**
 * Expand `FASTAGENT_ENV` into the process environment — what `start` does first on a host that carries the value file
 * that way. The platform's own variables still win, as they do over a value file anywhere.
 */
export function applyCarriedEnv(env: NodeJS.ProcessEnv = process.env): void {
  const carried = collectCarriedEnv(env);
  if (carried) for (const [name, value] of Object.entries(carried)) if (!(name in env)) env[name] = value;
}

/** The carried variables as the base64 JSON {@link collectCarriedEnv} reads back; empty when nothing travels. */
export function encodeCarriedEnv(carried: Readonly<Record<string, string>>): string {
  return Object.keys(carried).length === 0 ? "" : Buffer.from(JSON.stringify(carried), "utf8").toString("base64");
}
