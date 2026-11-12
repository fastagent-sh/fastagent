/**
 * What an agent's author writes: `defineAgent()` in `fastagent.config.ts`, `needs()` around the
 * code that reads a secret, and `defineSchedule()` in `src/schedules/`. Each returns what it was given, typed; the
 * assembly (open.ts) reads them back.
 */
import type { ModelThinkingLevel, Provider } from "@earendil-works/pi-ai";
import type { Schema } from "@earendil-works/pi-schema";
import { isEnvName } from "../../declared-secrets.ts";
import type { ScheduleConfig } from "../../schedule/schedule.ts";

/** What an instance may set over the program's `defaults`, and what a program's `defaults` are. */
export interface AgentDefaults<Settings = unknown> {
  /** Example first messages a client may offer as drafts, up to six: `info().starters`. */
  starters?: readonly string[];
  /** `"provider/modelId"`: what a session that names none answers with; a flag or `FASTAGENT_MODEL` may override it. */
  model?: string;
  thinkingLevel?: ModelThinkingLevel;
  http?: {
    /** The port a serve listens on, for its channels' webhooks and its health check. */
    port?: number;
    /**
     * Whether a serve answers the Agent API under `/v1` with a key (default true): `dev`, `start`, and every deployment,
     * which `deploy` gives a key. `false` keeps it to its channels and schedules, whatever key its environment holds.
     */
    api?: boolean;
    /**
     * The public base URL the platforms reach this instance at, any mount prefix included (`https://x.fly.dev/agent`):
     * a serve points each webhook channel there. Unset, none is pointed. Never inferred from the environment.
     */
    publicUrl?: string;
  };
  /** How the agent is deployed, where a host needs to be told. */
  deploy?: { agentcore?: { idleTimeoutSeconds?: number } };
  /**
   * Each channel by its file's name: how it receives, for a channel that can do either (`byIngress`). Unset, `dev`
   * receives by WebSocket (no public URL there) and everything else by webhook, which a host that wakes on a request
   * needs.
   */
  channels?: Record<string, { ingress?: Ingress }>;
  /** Values of the program's `settings`; an instance gives the rest. */
  settings?: Partial<Settings>;
}

export interface AgentConfig<Settings = unknown> {
  /** Constant: model providers beyond pi-ai's built-ins (a self-hosted endpoint, a gateway); a built-in's id replaces it. */
  providers?: readonly (Provider | Needs<Provider>)[];
  /** What each instance may choose, as an object schema (`obj({ ... })` from `@earendil-works/pi-schema`); no secrets. */
  settings?: Schema<Settings>;
  /** What an instance gets unless its configuration says otherwise. */
  defaults?: AgentDefaults<Settings>;
}

/** The settings an `AgentConfig` declares: what `fastagent build` types a package's definition by. */
export type SettingsOf<Config> = Config extends AgentConfig<infer Settings> ? Settings : unknown;

/** @public */
export function defineAgent<Settings = unknown>(config: AgentConfig<Settings>): AgentConfig<Settings> {
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
  build(values: Record<string, string | undefined>, settings: Readonly<Record<string, unknown>>): T;
}

/**
 * Wrap a module so it is built when an instance opens, with the values of the secrets it declares and the instance's
 * resolved `settings` (the program's `settings` schema, defaults and the instance's values, checked). Annotate the
 * second parameter with `SettingsOf<typeof config>` to type it. With no secrets, `needs([], (_, settings) => ...)`.
 * @public
 */
export function needs<const S extends readonly SecretSpec[], T, Settings = Readonly<Record<string, unknown>>>(
  secrets: S,
  build: (values: SecretValues<S>, settings: Settings) => T,
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
    build: (values, settings) => build(values as SecretValues<S>, settings as Settings),
  };
}

export function isNeeds(value: unknown): value is Needs<unknown> {
  return (value as { kind?: unknown } | null)?.kind === "fastagent.needs";
}

/** How a channel receives: inbound HTTP requests, or a connection it opens itself and keeps. */
export type Ingress = "webhook" | "connection";

/** A channel that can receive either way, each way's module (or `needs` around it) under its name. */
export interface ByIngress<T = unknown> {
  readonly kind: "fastagent.by-ingress";
  readonly webhook: T | Needs<T>;
  readonly connection: T | Needs<T>;
}

/**
 * Default-export from `src/channels/<name>.ts` a channel that receives either way: each instance takes the one its
 * configuration names (`channels.<name>.ingress`), and without one `dev` takes `connection` and everything else
 * `webhook`. Each way declares its own secrets, so an instance is asked only for its way's.
 * @public
 */
export function byIngress<T>(ways: { webhook: T | Needs<T>; connection: T | Needs<T> }): ByIngress<T> {
  return { kind: "fastagent.by-ingress", webhook: ways.webhook, connection: ways.connection };
}

export function isByIngress(value: unknown): value is ByIngress {
  return (value as { kind?: unknown } | null)?.kind === "fastagent.by-ingress";
}

/** What `src/schedules/<name>.ts` default-exports. */
export interface DefinedSchedule extends ScheduleConfig {
  readonly kind: "fastagent.schedule";
}

/** @public */
export function defineSchedule(config: ScheduleConfig): DefinedSchedule {
  return { kind: "fastagent.schedule", ...config };
}
