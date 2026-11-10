/**
 * A definition as a value (agent-artifact.md §3.5): what `dev` loads from a source project and what a built package
 * will export, one frozen shape every opener assembles from. Its declared inputs are read once, when it is made.
 */
import { loadEnvironment } from "../../content/file.ts";
import type { DeclaredSecret } from "../../declared-secrets.ts";
import { declaredVariables } from "../../environment/declare.ts";
import { type McpInstance, declareMcp, mcpSecrets } from "../../mcp/config.ts";
import { AGENT_CONFIG_FILE as CONFIG_FILE } from "../../paths.ts";
import { servedByDev } from "../../serving-command.ts";
import { type AgentConfig, type Ingress, isByIngress, isNeeds } from "./define.ts";
import { REGISTRY_KINDS, type Registry } from "./registry.ts";

/** What an opener of this FastAgent reads; a definition made for another refuses. */
export const DEFINITION_FORMAT = 1;

const DEFINITION = Symbol.for("fastagent.definition");
declare const SETTINGS: unique symbol;

/** A way of receiving that reads a secret: one channel's, by its name. */
interface IngressCondition {
  channel: string;
  ingress: Ingress;
}

/** A secret an instance must or may be given (SPEC.md §8): each name once, required when any declaration requires it. */
interface DeclaredInput {
  name: string;
  description?: string;
  optional: boolean;
  declaredIn: readonly string[];
  /** Only these channels' ways read it; absent, every instance does. */
  whenIngress?: readonly IngressCondition[];
}

/** `AgentDefinition<Settings>`: typed by the program's settings, so an embedder's `settings` input is checked. */
export interface AgentDefinition<Settings = unknown> {
  /** Phantom: carries `Settings` to the open's input types; nothing exists at run time. */
  readonly [SETTINGS]?: Settings;
  readonly [DEFINITION]: true;
  readonly format: number;
  /** The FastAgent version that made it: what a refusal of its format asks the opener to install. */
  readonly builtWith: string;
  /** The package's name (`package.json`'s, else the directory's): `info().agent.name`. */
  readonly name: string;
  readonly version: string;
  /** The package's `description`: `info().agent.description` unless an instance gives its own. */
  readonly description?: string;
  /** True for a source project the author works in (`dev`), absent for a built package, which an instance only reads. */
  readonly source?: true;
  /** Absolute: the program's files, its text and `context.json`. */
  readonly dir: string;
  readonly config: AgentConfig;
  readonly registry: Registry;
  readonly inputs: { readonly secrets: readonly DeclaredInput[] };
}

/** The value an opener was given, checked to be a definition this FastAgent assembles; a refusal says why. */
export function assertDefinition(value: unknown): AgentDefinition {
  if (typeof value !== "object" || value === null || !(DEFINITION in value)) {
    throw new Error("openAgent needs an agent package's default export (a definition `fastagent build` made)");
  }
  const definition = value as AgentDefinition;
  if (definition.format !== DEFINITION_FORMAT) {
    throw new Error(
      `${definition.name} was built as definition format ${definition.format}, and this FastAgent opens format ` +
        `${DEFINITION_FORMAT}: install @fastagent-sh/fastagent ${definition.builtWith}`,
    );
  }
  return definition;
}

type DefinitionSpec = Omit<AgentDefinition, typeof DEFINITION | "inputs">;

/** The value, frozen down to its lists and entries; the modules' own exports stay as their authors made them. */
export function defineDefinition(spec: DefinitionSpec): AgentDefinition {
  const registry = Object.freeze(
    Object.fromEntries(
      REGISTRY_KINDS.map((kind) => [
        kind,
        Object.freeze(spec.registry[kind].map((entry) => Object.freeze({ ...entry }))),
      ]),
    ) as Registry,
  );
  const config = Object.freeze({
    ...spec.config,
    ...(spec.config.providers === undefined ? {} : { providers: Object.freeze([...spec.config.providers]) }),
    ...(spec.config.settings === undefined ? {} : { settings: deepFreeze(structuredClone(spec.config.settings)) }),
    ...(spec.config.defaults === undefined ? {} : { defaults: deepFreeze(structuredClone(spec.config.defaults)) }),
  });
  return Object.freeze({
    [DEFINITION]: true as const,
    ...spec,
    config,
    registry,
    inputs: Object.freeze({ secrets: Object.freeze(byName(definitionSecrets(spec))) }),
  });
}

/** Plain data, frozen all the way down: a schema and defaults are JSON, which no instance may change. */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/**
 * One input per name, in name order: required when any declaration requires it, every place it is declared, and the
 * ways of receiving that read it when only some do.
 */
function byName(declared: readonly DeclaredSecret[]): DeclaredInput[] {
  const groups = new Map<string, DeclaredSecret[]>();
  for (const secret of declared) groups.set(secret.name, [...(groups.get(secret.name) ?? []), secret]);
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, all]) => {
      const optional = all.every((secret) => secret.optional);
      const description = all.find((secret) => secret.description !== undefined)?.description;
      const whenIngress = conditionsOf(optional ? all : all.filter((secret) => !secret.optional));
      return Object.freeze({
        name,
        ...(description === undefined ? {} : { description }),
        optional,
        declaredIn: Object.freeze([...new Set(all.map((secret) => secret.declaredIn))]),
        ...(whenIngress === undefined ? {} : { whenIngress: Object.freeze(whenIngress) }),
      });
    });
}

/**
 * The ways of receiving under which `deciding` reads a name: none when one of them always does, or when a channel's
 * both ways do, since every instance then receives one of them.
 */
function conditionsOf(deciding: readonly DeclaredSecret[]): IngressCondition[] | undefined {
  if (deciding.some((secret) => secret.when === undefined)) return undefined;
  const conditions: IngressCondition[] = [];
  for (const { when } of deciding) {
    const { channel, ingress } = when as IngressCondition;
    if (!conditions.some((c) => c.channel === channel && c.ingress === ingress)) conditions.push({ channel, ingress });
  }
  const bothWays = conditions.some(({ channel }) => conditions.filter((c) => c.channel === channel).length === 2);
  return bothWays ? undefined : conditions;
}

/** The channels part of a configuration: how each channel that receives either way receives. */
interface ChannelsConfig {
  channels?: Readonly<Record<string, { ingress?: Ingress }>>;
}

/** A channels configuration and whether `fastagent dev` serves the instance (else the process's own say, `servedByDev`). */
export interface IngressConfig extends ChannelsConfig {
  dev?: boolean;
}

/**
 * How the channel `name` receives under `config`: what it names, else WebSocket under `dev` (no public URL there) and
 * webhook everywhere else (a host that wakes on a request reaches it only that way).
 */
export function chosenIngress(
  config: IngressConfig,
  name: string,
  dev: boolean = config.dev ?? servedByDev(),
): Ingress {
  return config.channels?.[name]?.ingress ?? (dev ? "connection" : "webhook");
}

/** A value that may hold `Needs`, where it is, and the way of receiving it is read under when only one is. */
interface Declarer {
  declaredIn: string;
  value: unknown;
  when?: IngressCondition;
}

/**
 * Every value the definition can hold `Needs` in, with where it is: modules by file, configuration by key. A channel
 * that receives either way is the way `config` chooses; with no configuration, both ways, each with its condition.
 */
function declarers(
  { registry, config }: Pick<DefinitionSpec, "registry" | "config">,
  instance?: IngressConfig,
): Declarer[] {
  const ways = ({ file, name, value }: { file: string; name: string; value: unknown }): Declarer[] => {
    if (!isByIngress(value)) return [{ declaredIn: file, value }];
    if (instance !== undefined) return [{ declaredIn: file, value: value[chosenIngress(instance, name)] }];
    return (["webhook", "connection"] as const).map((ingress) => ({
      declaredIn: file,
      value: value[ingress],
      when: { channel: name, ingress },
    }));
  };
  return [
    ...REGISTRY_KINDS.flatMap((kind) => registry[kind].flatMap(ways)),
    ...(config.providers ?? []).map((value, i) => ({ declaredIn: `${CONFIG_FILE} providers[${i}]`, value })),
  ];
}

type Declaring = Pick<DefinitionSpec, "registry" | "config" | "dir">;

/**
 * The secrets the definition's code reads (`needs()`) and its commands do (`context.json`'s variables): an instance's,
 * under its `config`, or every way's with none.
 */
export function codeSecrets(definition: Declaring, config?: IngressConfig): DeclaredSecret[] {
  return [
    ...declarers(definition, config).flatMap(({ declaredIn, value, when }) =>
      isNeeds(value)
        ? value.secrets.map((secret) => ({ ...secret, declaredIn, ...(when === undefined ? {} : { when }) }))
        : [],
    ),
    ...declaredVariables(loadEnvironment(definition.dir)),
  ];
}

/**
 * Every declaration of a secret, each where it is: the code's, then the references of the MCP servers, the program's
 * and, given `instance`, the ones it adds.
 */
export function definitionSecrets(
  definition: Declaring,
  config?: IngressConfig,
  instance?: McpInstance,
): DeclaredSecret[] {
  return [...codeSecrets(definition, config), ...mcpSecrets(declareMcp(definition.dir, instance))];
}
