/**
 * The environment a deployed agent runs with — host-neutral.
 *
 * Docker, Fly and Railway keep a deployment's values in a store of their own and are never handed a file (secret-store.ts):
 * what the definition declares (`needs()`, plus the model's env key) says which names must have a value there.
 * AgentCore's store is a Secrets Manager secret (agentcore/store.ts).
 */
import { type DeclaredSecret, dedupeSecrets } from "../declared-secrets.ts";

/** Is this local auth source an env-var API key (→ becomes a deploy secret) vs OAuth / stored / none? */
export function isEnvKey(source: string | undefined): source is string {
  return source !== undefined && /^[A-Z][A-Z0-9_]*$/.test(source);
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
 * The stop for a host CLI signed out with nobody to sign it in. A token goes in the shell's (or CI's) environment,
 * never among a deployment's values, which would travel to the box with the others.
 */
export function hostSignedOutGate(host: string, login: string, token: string, _forAgent?: string): string {
  return (
    `not logged in to ${host} — run \`${login}\` in a terminal (it opens a browser), or set ${token} in this ` +
    `shell's environment (it is not a value of the deployment); then re-run`
  );
}
