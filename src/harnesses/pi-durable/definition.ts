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

export interface AgentDefinition {
  readonly [DEFINITION]: true;
  readonly format: number;
  readonly name: string;
  readonly version: string;
  /** Absolute: the program's files, its text, `context.json` and `mcp.json`. */
  readonly dir: string;
  readonly config: AgentConfig;
  readonly registry: Registry;
  /** What an instance must or may be given: every secret, wherever it is declared. */
  readonly inputs: { readonly secrets: readonly DeclaredSecret[] };
}

type DefinitionSpec = Omit<AgentDefinition, typeof DEFINITION | "inputs">;

export function defineDefinition(spec: DefinitionSpec): AgentDefinition {
  const secrets = [...codeSecrets(spec), ...mcpSecrets(spec.dir)].sort((a, b) => a.name.localeCompare(b.name));
  return Object.freeze({
    [DEFINITION]: true as const,
    ...spec,
    inputs: Object.freeze({ secrets: Object.freeze(secrets) }),
  });
}

/** Every value the definition can hold `Needs` in, with where it is: modules by file, configuration by key. */
function declarers({ registry, config }: Pick<DefinitionSpec, "registry" | "config">) {
  return [
    ...REGISTRY_KINDS.flatMap((kind) => registry[kind].map(({ file, value }) => ({ declaredIn: file, value }))),
    ...(config.extensions ?? []).map((value, i) => ({ declaredIn: `${CONFIG_FILE} extensions[${i}]`, value })),
    ...(config.providers ?? []).map((value, i) => ({ declaredIn: `${CONFIG_FILE} providers[${i}]`, value })),
  ];
}

/** The secrets the definition's code reads (`needs()`) and its commands do (`context.json`'s variables). */
export function codeSecrets(definition: Pick<DefinitionSpec, "registry" | "config" | "dir">): DeclaredSecret[] {
  return [
    ...declarers(definition).flatMap(({ declaredIn, value }) =>
      isNeeds(value) ? value.secrets.map((secret) => ({ ...secret, declaredIn })) : [],
    ),
    ...declaredVariables(loadEnvironment(definition.dir)),
  ];
}
