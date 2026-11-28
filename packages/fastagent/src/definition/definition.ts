/**
 * A definition as a value: what `dev` loads from a source project and what a built package
 * will export, one frozen shape every opener assembles from. Its declared inputs are read once, when it is made.
 */
import type { DeclaredSecret } from "../declared-secrets.ts";
import { declareMcp, mcpSecrets } from "../mcp/config.ts";
import { AGENT_CONFIG_FILE as CONFIG_FILE } from "../paths.ts";
import { isNeeds } from "../needs.ts";
import type { AgentConfig } from "../harnesses/define.ts";
import { REGISTRY_KINDS, type Registry } from "./registry.ts";

/** What an opener of this FastAgent reads; a definition made for another refuses. */
export const DEFINITION_FORMAT = 3;

const DEFINITION = Symbol.for("fastagent.definition");

/** A secret an instance must or may be given: each name once, required when any declaration requires it. */
interface DeclaredInput {
  name: string;
  description?: string;
  optional: boolean;
  declaredIn: readonly string[];
}

export interface AgentDefinition {
  readonly [DEFINITION]: true;
  readonly format: number;
  /** The FastAgent version that made it: what a refusal of its format asks the opener to install. */
  readonly builtWith: string;
  /** The package's name (`package.json`'s, else the directory's): `info().agent.name`. */
  readonly name: string;
  readonly version: string;
  /** The package's `description`: `info().agent.description`. */
  readonly description?: string;
  /** True for a source project the author works in (`dev`), absent for a built package, which an instance only reads. */
  readonly source?: true;
  /** Absolute: the program's files, its text and `fastagent.config.ts`. */
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
    ...(Array.isArray(spec.config.codingTools) ? { codingTools: Object.freeze([...spec.config.codingTools]) } : {}),
    ...(spec.config.providers === undefined ? {} : { providers: Object.freeze([...spec.config.providers]) }),
    ...(spec.config.starters === undefined ? {} : { starters: Object.freeze([...spec.config.starters]) }),
  });
  return Object.freeze({
    [DEFINITION]: true as const,
    ...spec,
    config,
    registry,
    inputs: Object.freeze({ secrets: Object.freeze(byName(definitionSecrets(spec))) }),
  });
}

/** One input per name, in name order: required when any declaration requires it, and every place it is declared. */
function byName(declared: readonly DeclaredSecret[]): DeclaredInput[] {
  const groups = new Map<string, DeclaredSecret[]>();
  for (const secret of declared) groups.set(secret.name, [...(groups.get(secret.name) ?? []), secret]);
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, all]) => {
      const optional = all.every((secret) => secret.optional);
      const description = all.find((secret) => secret.description !== undefined)?.description;
      return Object.freeze({
        name,
        ...(description === undefined ? {} : { description }),
        optional,
        declaredIn: Object.freeze([...new Set(all.map((secret) => secret.declaredIn))]),
      });
    });
}

/** Every value the definition can hold `Needs` in, with where it is: modules by file, configuration by key. */
function declarers({ registry, config }: Pick<DefinitionSpec, "registry" | "config">): Declarer[] {
  return [
    ...REGISTRY_KINDS.flatMap((kind) => registry[kind].map(({ file, value }) => ({ declaredIn: file, value }))),
    ...(config.providers ?? []).map((value, i) => ({ declaredIn: `${CONFIG_FILE} providers[${i}]`, value })),
  ];
}

interface Declarer {
  declaredIn: string;
  value: unknown;
}

type Declaring = Pick<DefinitionSpec, "registry" | "config" | "dir">;

/** The secrets the definition's code reads (`needs()`). */
export function codeSecrets(definition: Declaring): DeclaredSecret[] {
  return declarers(definition).flatMap(({ declaredIn, value }) =>
    isNeeds(value) ? value.secrets.map((secret) => ({ ...secret, declaredIn })) : [],
  );
}

/** Every declaration of a secret, each where it is: the code's, then the references of the MCP servers. */
export function definitionSecrets(definition: Declaring): DeclaredSecret[] {
  return [...codeSecrets(definition), ...mcpSecrets(declareMcp(definition.config.mcpServers, definition.dir))];
}
