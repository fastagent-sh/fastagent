/**
 * `needs()`: code that reads secrets, declared next to the read and built once their values are known, so the
 * declaration cannot drift from the read. A tool, an extension, a schedule, a provider or a channel may be one; the
 * assembly lists every declaration and refuses to open while a required one has no value.
 */
import { isEnvName } from "./declared-secrets.ts";

/** One secret a piece of code reads: by name, or with what it is for and whether the code runs without it. */
/** @public */
export type SecretSpec = string | { name: string; description?: string; optional?: boolean };

type NameOf<S> = S extends string ? S : S extends { name: infer N extends string } ? N : never;
type IsOptional<S> = S extends { optional: true } ? true : false;

/** The values a `needs` hands its code: a required secret is a string, an optional one may be absent. */
/** @public */
export type SecretValues<S extends readonly SecretSpec[]> = {
  [K in S[number] as IsOptional<K> extends true ? never : NameOf<K>]: string;
} & {
  [K in S[number] as IsOptional<K> extends true ? NameOf<K> : never]?: string;
};

/** Code that needs secrets, built once their values are known: the declaration cannot drift from the read. */
export interface Needs<T> {
  readonly kind: "fastagent.needs";
  readonly secrets: readonly { name: string; description?: string; optional: boolean }[];
  build(values: Record<string, string | undefined>): T;
}

/**
 * Wrap a module so it is built when the agent opens, with the values of the secrets it declares: a required one
 * without a value refuses the open, naming this file.
 * @public
 */
export function needs<const S extends readonly SecretSpec[], T>(
  secrets: S,
  build: (values: SecretValues<S>) => T,
): Needs<T> {
  const declared = secrets.map((spec) =>
    typeof spec === "string"
      ? { name: spec, optional: false }
      : {
          name: spec.name,
          optional: spec.optional === true,
          ...(spec.description === undefined ? {} : { description: spec.description }),
        },
  );
  for (const { name } of declared) {
    // Written verbatim into env files and deploy artifacts, where a malformed name breaks somewhere far away.
    if (!isEnvName(name)) throw new Error(`needs: ${JSON.stringify(name)} is not an environment variable name`);
  }
  return {
    kind: "fastagent.needs",
    secrets: declared,
    build: (values) => build(values as SecretValues<S>),
  };
}

export function isNeeds(value: unknown): value is Needs<unknown> {
  return (value as { kind?: unknown } | null)?.kind === "fastagent.needs";
}
