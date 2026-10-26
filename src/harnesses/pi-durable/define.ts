/**
 * What an agent's author writes (architecture.md §3): `defineAgent()` in `fastagent.config.ts`, `needs()` around the
 * code that reads a secret, and `defineSchedule()` in `src/schedules/`. Each returns what it was given, typed; the
 * assembly (open.ts) reads them back.
 */
import type { ModelThinkingLevel, Provider } from "@earendil-works/pi-ai";
import type { Extension } from "@earendil-works/pi-durable";
import type { ScheduleConfig } from "../../schedule/schedule.ts";

export interface AgentConfig {
  /** Default: `package.json`'s name. */
  name?: string;
  description?: string;
  /** `"provider/modelId"`: what a session that names none answers with; a deployment may override it. */
  model?: string;
  thinkingLevel?: ModelThinkingLevel;
  /** Third-party capabilities, installed after `src/extensions/`. */
  extensions?: readonly (Extension | Needs<Extension>)[];
  /** Model providers beyond pi-ai's built-ins (a self-hosted endpoint, a gateway); a built-in's id replaces it. */
  providers?: readonly (Provider | Needs<Provider>)[];
  /** The port a serve listens on, for its channels' webhooks and its health check. */
  http?: { port?: number };
  /** How the agent is deployed, where a host needs to be told. */
  deploy?: { agentcore?: { idleTimeoutSeconds?: number } };
}

/** @public */
export function defineAgent(config: AgentConfig): AgentConfig {
  return config;
}

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

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** @public */
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
    if (!ENV_NAME.test(name)) throw new Error(`needs: ${JSON.stringify(name)} is not an environment variable name`);
  }
  return { kind: "fastagent.needs", secrets: declared, build: (values) => build(values as SecretValues<S>) };
}

export function isNeeds(value: unknown): value is Needs<unknown> {
  return (value as { kind?: unknown } | null)?.kind === "fastagent.needs";
}

/** What `src/schedules/<name>.ts` default-exports. */
export interface DefinedSchedule extends ScheduleConfig {
  readonly kind: "fastagent.schedule";
}

/** @public */
export function defineSchedule(config: ScheduleConfig): DefinedSchedule {
  return { kind: "fastagent.schedule", ...config };
}
