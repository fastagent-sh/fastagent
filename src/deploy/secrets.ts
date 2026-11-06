/**
 * The environment a deployed agent runs with — host-neutral.
 *
 * Docker, Fly and Railway keep a deployment's values in a store of their own and are never handed a file (secret-store.ts):
 * what the definition declares (`defineTool`/`defineChannel`, the `variables` of `context.json`, plus the model's env key)
 * says which names must have a value there. AgentCore still carries the production value file whole (the functions below
 * that assemble and encode it), until its values move to Secrets Manager.
 */
import { type DeclaredSecret, dedupeSecrets, missingSecrets as unsetSecrets } from "../declared-secrets.ts";
import { DEV_SERVE_ENV } from "../serving-command.ts";
import { AGENT_ENVIRONMENT_ENV } from "../paths.ts";

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
  "FASTAGENT_MODEL",
  "FASTAGENT_CONFIG",
  "FASTAGENT_ROOT",
  "FASTAGENT_WORKDIR",
  "FASTAGENT_STATE_DIR",
  "FASTAGENT_SECRETS_DIR",
  "FASTAGENT_AUTH_PATH",
  "FASTAGENT_RELEASE_FILE",
  "FASTAGENT_STORAGE_DIR",
  "FASTAGENT_AGENTCORE",
  "FASTAGENT_INGRESS_SECRET",
  "FASTAGENT_WAKE_SECRET",
  "FASTAGENT_DEV_WORKER",
  DEV_SERVE_ENV,
  AGENT_ENVIRONMENT_ENV,
]);

/** Is `name` one the deployment sets itself (see {@link DEPLOY_OWNED}), including the chunked carriers? */
export function isDeployOwned(name: string): boolean {
  return DEPLOY_OWNED.has(name) || /^FASTAGENT_ENV(_\d+)?$/.test(name);
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
 * What a runbook lists: the names the deployment declares (the model's env key, every declaration — hinted by the file
 * that declared it).
 */
export function deploymentSecrets(
  modelAuth: string | undefined,
  declared: readonly DeclaredSecret[],
): DeploymentSecret[] {
  const secrets: DeploymentSecret[] = [];
  const add = (name: string, hint: string) => {
    if (!secrets.some((s) => s.name === name)) secrets.push({ name, hint });
  };
  if (isEnvKey(modelAuth)) add(modelAuth, "your model provider key");
  for (const { name } of dedupeSecrets(declared)) {
    // Hinted by a declaration that requires it, when one does: a name some declaration requires is required.
    const declarations = declared.filter((s) => s.name === name);
    const { declaredIn, description, optional } =
      declarations.find((s) => !s.optional) ?? (declarations[0] as DeclaredSecret);
    add(
      name,
      `${optional ? "optional, read by" : "required by"} ${declaredIn}${description ? `: ${description}` : ""}`,
    );
  }
  return secrets;
}

/** One name a deployment cannot start without, and where to find out what it is for. */
export interface SecretNeed {
  name: string;
  hint: string;
}

/** What the model's credential asks of the target (preflight.ts's `modelKey`). */
export interface ModelKey {
  /** The variables the provider reads its key from. */
  variables: readonly string[];
  /** One of them must be set: the value file holds no key and the provider has no login to run on the box. */
  required: boolean;
}

/**
 * The names the target must hold a value for: the key of a model with no other way in, the model's key when the value
 * file holds one, and every declaration that does not say the code runs without it, each hinted by the file that
 * declared it. A name some declaration requires is required.
 */
export function secretNeeds(
  modelAuth: string | undefined,
  declared: readonly DeclaredSecret[],
  modelKey?: ModelKey,
): SecretNeed[] {
  const needs: SecretNeed[] = [];
  if (isEnvKey(modelAuth)) needs.push({ name: modelAuth, hint: "your model provider key" });
  else if (modelKey?.required && modelKey.variables[0] !== undefined) {
    needs.push({ name: modelKey.variables[0], hint: "your model provider key: it has no login to run on the box" });
  }
  for (const { name } of dedupeSecrets(declared.filter((secret) => !secret.optional))) {
    if (needs.some((need) => need.name === name)) continue;
    const { declaredIn, description } = declared.find(
      (secret) => secret.name === name && !secret.optional,
    ) as DeclaredSecret;
    needs.push({ name, hint: `required by ${declaredIn}${description ? `: ${description}` : ""}` });
  }
  return needs;
}

/**
 * Every name the definition declares, optional ones and the model's keys included: what a source may supply, and what
 * `secrets list` shows.
 */
export function declaredNames(
  modelAuth: string | undefined,
  declared: readonly DeclaredSecret[],
  modelKey?: ModelKey,
): string[] {
  return [
    ...new Set([
      ...(isEnvKey(modelAuth) ? [modelAuth] : []),
      ...(modelKey?.variables ?? []),
      ...declared.map(({ name }) => name),
    ]),
  ];
}

/**
 * Assemble the VALUES a `--run` deploy sets on the host: every variable the value file carries. Never minted here.
 *
 * `values` is the selected value file, read as data — **the environment running `deploy` is not a source**. A
 * deployment must be reproducible from what it carries, and a variable that happens to be exported on the builder is
 * written down nowhere. CI supplies values by writing the file before running the command.
 *
 * No credentials file travels: a model that does not authenticate through a variable (or its own definition) logs in
 * on the deployment itself (`fastagent login --deployment`), so the box is the only holder of its grant.
 */
export function assembleSecrets(input: {
  modelAuth: string | undefined;
  /** Every name the definition declared it needs — what must have a value. */
  declared?: readonly DeclaredSecret[];
  /** The selected value file's contents (`loadEnvValues`). The ONLY source of operator-supplied values. */
  values: ReadonlyMap<string, string>;
}): { secrets: Record<string, string>; missingSecrets: string[] } {
  const secrets = carriedValues(input.values);
  const missingSecrets: string[] = [];
  if (isEnvKey(input.modelAuth) && !secrets[input.modelAuth]) missingSecrets.push(input.modelAuth);
  for (const { name } of unsetSecrets(input.declared ?? [], secrets)) {
    if (!missingSecrets.includes(name)) missingSecrets.push(name);
  }
  return { secrets, missingSecrets };
}

/**
 * The stop for a host CLI signed out with nobody to sign it in. A token goes in the shell's (or CI's) environment,
 * never in the production value file: everything there travels to the box, which runs an agent with a shell.
 */
export function hostSignedOutGate(host: string, login: string, token: string, forAgent: string): string {
  return (
    `not logged in to ${host} — run \`${login}\` in a terminal (it opens a browser), or set ${token} in this ` +
    `shell's environment, never in .secrets/production/.env (everything there travels to the box); then re-run. ` +
    `From a coding agent, \`${forAgent}\` hands the sign-in to its user`
  );
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
