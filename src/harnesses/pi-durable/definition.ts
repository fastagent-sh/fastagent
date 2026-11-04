/**
 * A definition as a value (agent-artifact.md §3.5): what `dev` loads from a source project and what a built package
 * will export, one frozen shape every opener assembles from. Its declared inputs are read once, when it is made.
 */
import { loadEnvironment } from "../../content/file.ts";
import type { DeclaredSecret } from "../../declared-secrets.ts";
import { declaredVariables } from "../../environment/declare.ts";
import { mcpSecrets } from "../../mcp/config.ts";
import { AGENT_CONFIG_FILE as CONFIG_FILE } from "../../paths.ts";
import { type AgentConfig, isNeeds } from "./define.ts";
import { REGISTRY_KINDS, type Registry } from "./registry.ts";

/** What an opener of this FastAgent reads; a definition made for another refuses. */
export const DEFINITION_FORMAT = 1;

const DEFINITION = Symbol.for("fastagent.definition");

/** A secret an instance must or may be given (SPEC.md §8): each name once, required when any declaration requires it. */
interface DeclaredInput {
  name: string;
  description?: string;
  optional: boolean;
  declaredIn: readonly string[];
}

export interface AgentDefinition {
  readonly [DEFINITION]: true;
  readonly format: number;
  readonly name: string;
  readonly version: string;
  /** Absolute: the program's files, its text, `context.json` and `mcp.json`. */
  readonly dir: string;
  readonly config: AgentConfig;
  readonly registry: Registry;
  readonly inputs: { readonly secrets: readonly DeclaredInput[] };
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
    ...(spec.config.extensions === undefined ? {} : { extensions: Object.freeze([...spec.config.extensions]) }),
    ...(spec.config.providers === undefined ? {} : { providers: Object.freeze([...spec.config.providers]) }),
  });
  return Object.freeze({
    [DEFINITION]: true as const,
    ...spec,
    config,
    registry,
    inputs: Object.freeze({ secrets: Object.freeze(byName(definitionSecrets(spec))) }),
  });
}

/** One input per name, in name order: required when any declaration requires it, every place it is declared. */
function byName(declared: readonly DeclaredSecret[]): DeclaredInput[] {
  const inputs = new Map<string, { name: string; description?: string; optional: boolean; declaredIn: string[] }>();
  for (const { name, description, optional, declaredIn } of declared) {
    const input = inputs.get(name) ?? { name, optional: true, declaredIn: [] };
    input.optional &&= optional;
    input.declaredIn.push(declaredIn);
    if (input.description === undefined && description !== undefined) input.description = description;
    inputs.set(name, input);
  }
  return [...inputs.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((input) => Object.freeze({ ...input, declaredIn: Object.freeze(input.declaredIn) }));
}

/** Every value the definition can hold `Needs` in, with where it is: modules by file, configuration by key. */
function declarers({ registry, config }: Pick<DefinitionSpec, "registry" | "config">) {
  return [
    ...REGISTRY_KINDS.flatMap((kind) => registry[kind].map(({ file, value }) => ({ declaredIn: file, value }))),
    ...(config.extensions ?? []).map((value, i) => ({ declaredIn: `${CONFIG_FILE} extensions[${i}]`, value })),
    ...(config.providers ?? []).map((value, i) => ({ declaredIn: `${CONFIG_FILE} providers[${i}]`, value })),
  ];
}

type Declaring = Pick<DefinitionSpec, "registry" | "config" | "dir">;

/** The secrets the definition's code reads (`needs()`) and its commands do (`context.json`'s variables). */
export function codeSecrets(definition: Declaring): DeclaredSecret[] {
  return [
    ...declarers(definition).flatMap(({ declaredIn, value }) =>
      isNeeds(value) ? value.secrets.map((secret) => ({ ...secret, declaredIn })) : [],
    ),
    ...declaredVariables(loadEnvironment(definition.dir)),
  ];
}

/** Every declaration of a secret, each where it is: the code's, then `mcp.json`'s references. */
export function definitionSecrets(definition: Declaring): DeclaredSecret[] {
  return [...codeSecrets(definition), ...mcpSecrets(definition.dir)];
}
