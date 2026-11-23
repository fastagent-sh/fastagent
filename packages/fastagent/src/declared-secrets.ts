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
export function definedValues(secrets: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(
    Iterator.from(Object.entries(secrets)).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

/** Required names with no value in `env` — empty string counts as missing (an unset `.env` line). A name some
 *  declaration requires is required, whatever another says. */
export function missingSecrets(
  declared: readonly DeclaredSecret[],
  env: Readonly<Record<string, string | undefined>>,
): DeclaredSecret[] {
  return dedupeSecrets(declared.filter((secret) => !secret.optional)).filter((secret) => !env[secret.name]);
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
