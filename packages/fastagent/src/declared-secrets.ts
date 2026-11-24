/**
 * WHICH ENV VARS THIS AGENT NEEDS, in ONE shape, wherever it was declared (`needs(...)`, next to the code that reads
 * the value).
 *
 * Opening the agent ASSERTS the values first, so a missing one is a startup failure naming the file, not a 401 three
 * days later.
 *
 * Agent code does not read `process.env`: `needs` hands back exactly the values it declared, so the declaration cannot
 * drift from the read, and a typo is a type error. The values travel through the process env: a declaration makes a
 * value REQUIRED, it does not decide what travels.
 */

import * as Redacted from "effect/Redacted";

/** A secret accepted at a public boundary: plain string or already-redacted. */
export type SecretInput = string | Redacted.Redacted<string>;

/** Internal secret map holding every value as `Redacted<string>` so logs and JSON never reveal plaintext. */
export type RedactedSecrets = Readonly<Record<string, Redacted.Redacted<string>>>;

/** Boundary input shape for secret maps (plain strings, redacted values, or unset entries). */
export type SecretValuesInput = Readonly<Record<string, SecretInput | undefined>>;

/** Wrap a boundary secret in `Redacted<string>` without double-wrapping. */
export function redactSecret(value: SecretInput): Redacted.Redacted<string> {
  return Redacted.isRedacted(value) ? value : Redacted.make(value);
}

/** Unwrap a secret at an explicit outbound auth or env-injection boundary. */
export function revealSecret(value: SecretInput): string {
  return Redacted.isRedacted(value) ? Redacted.value(value) : value;
}

/** Normalize a boundary secret map into an immutable map of `Redacted<string>` values. */
export function redactValues(secrets: SecretValuesInput): RedactedSecrets {
  return Object.fromEntries(
    Iterator.from(Object.entries(secrets))
      .filter((entry): entry is [string, SecretInput] => entry[1] !== undefined)
      .map(([name, value]) => [name, redactSecret(value)] as const),
  );
}

/** Unwrap a redacted secret map at an outbound env-injection boundary (`needs`, MCP, models, child processes). */
export function revealValues(secrets: RedactedSecrets): Record<string, string> {
  return Object.fromEntries(
    Iterator.from(Object.entries(secrets)).map(([name, value]) => [name, Redacted.value(value)] as const),
  );
}

/** One env var some part of the definition declared, and where that declaration is. */
export interface DeclaredSecret {
  /** The env-var name. */
  readonly name: string;
  /** Where it was declared: "src/tools/x-post.ts", "fastagent.config.ts providers[0]" — printed in
   *  runbooks and failures, so it must name a place the author can open. */
  readonly declaredIn: string;
  /** What it is for, when the declaration says: printed beside it in runbooks. */
  readonly description?: string;
  /** The code runs without it: no start is refused for its absence. */
  readonly optional: boolean;
}

/** Declared names as a stable list, first declaration winning — the form a carrier iterates. */
function dedupeSecrets(declared: readonly DeclaredSecret[]): readonly DeclaredSecret[] {
  return Iterator.from(Map.groupBy(declared, (secret) => secret.name).values())
    .flatMap(([first]) => (first === undefined ? [] : [first]))
    .toArray();
}

/** The values of `secrets` that are set: what an environment is made of, since a name given no value is not one. */
export function definedValues(secrets: SecretValuesInput): Record<string, string> {
  return Object.fromEntries(
    Iterator.from(Object.entries(secrets))
      .filter((entry): entry is [string, SecretInput] => entry[1] !== undefined)
      .map(([name, value]) => [name, revealSecret(value)] as const),
  );
}

/** Required names with no value in `env` — empty string counts as missing (an unset `.env` line). A name some
 *  declaration requires is required, whatever another says. */
export function missingSecrets(declared: readonly DeclaredSecret[], env: SecretValuesInput): DeclaredSecret[] {
  return dedupeSecrets(declared.filter((secret) => !secret.optional)).filter((secret) => {
    const value = env[secret.name];
    return value === undefined || revealSecret(value) === "";
  });
}

/** "X_API_KEY, X_API_SECRET (src/tools/x-post.ts); GATEWAY_KEY (fastagent.config.ts providers[0])", grouped
 *  by where it is declared, since that is the unit the author fixes. */
export function describeSecrets(declared: readonly DeclaredSecret[]): string {
  const bySource = Map.groupBy(dedupeSecrets(declared), (secret) => secret.declaredIn);
  return Iterator.from(bySource.entries())
    .map(([source, secrets]) => `${secrets.map((secret) => secret.name).join(", ")} (${source})`)
    .toArray()
    .join("; ");
}
