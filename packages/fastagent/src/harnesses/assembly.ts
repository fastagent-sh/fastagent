/**
 * Harness-neutral definition assembly: reads a source project (`fastagent.config.ts` and `src/`) as an
 * `AgentDefinition`, resolves `needs()` secrets, validates tools/extensions/providers, and resolves model specs.
 */
import { basename, resolve } from "node:path";
import type { Models, Provider } from "@earendil-works/pi-ai";
import type { AgentInfo, ModelRef } from "@fastagent-sh/client/agent-api";
import { describeSecrets, missingSecrets } from "../declared-secrets.ts";
import { type AgentDefinition, DEFINITION_FORMAT, codeSecrets, defineDefinition } from "../definition/definition.ts";
import { importRegistry } from "../definition/registry.ts";
import { log } from "../log.ts";
import { modelRefOf } from "../model-ref.ts";
import { type Needs, isNeeds } from "../needs.ts";
import { AGENT_CONFIG_FILE as CONFIG_FILE } from "../paths.ts";
import { decodeRuntimeCliEnv } from "../process-env.ts";
import { loadRawProgramConfig } from "../program-config.ts";
import { readPackageJson } from "../runtime.ts";
import { fastagentVersion } from "../version.ts";
import { checkProgramConfig, resolveCodingTools } from "./config.ts";
import type { AgentConfig } from "./define.ts";

/** Reserved internal extension names that authored extensions may not shadow. */
export const DEFINITION_EXTENSION = "fastagent.definition";
const CODING_TOOLS_EXTENSION = "coding-tools";

/** What a process does with messages an earlier process accepted and did not finish. */
export type Unfinished = "resume" | "refuse";

async function loadConfig(dir: string): Promise<AgentConfig> {
  const { value, file } = await loadRawProgramConfig(dir);
  return checkProgramConfig(value, file);
}

/** The default model a process runs with: `--model` > `FASTAGENT_MODEL` > the configuration's `model`. */
export function modelSpecFor(
  config: Pick<AgentConfig, "model">,
  flag: string | undefined,
  env?: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const fromEnv = env === undefined ? decodeRuntimeCliEnv().model : env.FASTAGENT_MODEL;
  return flag ?? (fromEnv || config.model);
}

/** The source project in `dir` as a definition: `fastagent.config.ts` (optional) and the modules of `src/`. */
export async function loadSourceDefinition(directory: string): Promise<AgentDefinition> {
  const dir = resolve(directory);
  const config = await loadConfig(dir);
  const registry = await importRegistry(dir);
  const pkg = (await readPackageJson(dir)) as { name?: unknown; version?: unknown; description?: unknown };
  return defineDefinition({
    format: DEFINITION_FORMAT,
    builtWith: await fastagentVersion(),
    name: typeof pkg.name === "string" ? pkg.name : basename(dir),
    version: typeof pkg.version === "string" ? pkg.version : "0.0.0",
    ...(typeof pkg.description === "string" && pkg.description.trim() !== "" ? { description: pkg.description } : {}),
    source: true,
    dir,
    config,
    registry,
  });
}

function built<T>(
  source: string,
  value: unknown,
  values: Record<string, string | undefined>,
  accept: (v: unknown) => string | undefined,
): T {
  const resolved = isNeeds(value) ? (value as Needs<unknown>).build(values) : value;
  const problem = accept(resolved);
  if (problem !== undefined) throw new Error(`${source}: ${problem}`);
  return resolved as T;
}

const toolProblem = (value: unknown): string | undefined => {
  const tool = value as Partial<AuthoredTool> | null;
  if (
    tool?.parameters !== null &&
    (typeof tool?.parameters === "object" || typeof tool?.parameters === "function") &&
    "~standard" in tool.parameters
  ) {
    return 'parameters is an unconverted Standard Schema: wrap the tool with defineTool from "@fastagent-sh/fastagent"';
  }
  if (
    typeof tool?.name !== "string" ||
    typeof tool.description !== "string" ||
    typeof tool.parameters !== "object" ||
    tool.parameters === null ||
    Array.isArray(tool.parameters) ||
    typeof tool.execute !== "function"
  ) {
    return "must default-export a tool (defineTool from @fastagent-sh/fastagent or @earendil-works/pi-durable), or needs(...) around one";
  }
  return undefined;
};

const extensionProblem = (value: unknown): string | undefined =>
  typeof (value as Partial<AuthoredExtension> | null)?.name === "string"
    ? undefined
    : "must be an extension (defineExtension from @earendil-works/pi-durable), or needs(...) around one";

const providerProblem = (value: unknown): string | undefined =>
  typeof (value as Partial<Provider> | null)?.id === "string" ? undefined : "must be a pi-ai provider (createProvider)";

const named = <T extends { name: string }>(value: T) => ({ name: value.name, value });

function refuseTwins(kind: string, entries: readonly { source: string; name: string }[]): void {
  const first = new Map<string, string>();
  for (const { source, name } of entries) {
    const earlier = first.get(name);
    if (earlier !== undefined) throw new Error(`${earlier} and ${source} both define the ${kind} "${name}"`);
    first.set(name, source);
  }
}

/** Minimal structural shape shared by portable `defineTool` registrations and `pi-durable` tools. */
export interface AuthoredTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: object;
  readonly outputLimits?: { readonly maxBytes?: number; readonly maxLines?: number; readonly retain?: "head" | "tail" };
  readonly replay?: "safe" | "unsafe";
  prepareArguments?(args: unknown): unknown;
  execute(
    args: unknown,
    api: never,
    context: never,
  ): Promise<{ readonly output?: ReadonlyArray<{ readonly type: string }> }>;
}

/** Minimal structural shape validated for `src/extensions/*` modules (`pi-durable`-specific). */
interface AuthoredExtension {
  readonly name: string;
  readonly tools?: readonly { readonly name: string }[];
}

/** The definition's code, built with the values of the secrets it declares. */
export interface BuiltDefinition {
  tools: AuthoredTool[];
  extensions: AuthoredExtension[];
  providers: Provider[];
}

function checkStatic<T>(source: string, value: unknown, accept: (v: unknown) => string | undefined): T | undefined {
  if (isNeeds(value)) {
    if (typeof value.build !== "function") {
      throw new Error(`${source}: needs(...) factory must be a function`);
    }
    return undefined;
  }
  const problem = accept(value);
  if (problem !== undefined) throw new Error(`${source}: ${problem}`);
  return value as T;
}

/**
 * Validate statically knowable module exports without invoking `needs(...)` factories or requiring credentials.
 * Reuses the same shape and duplicate-name rules as {@link buildDefinition}.
 */
export function validateDefinitionStatic(definition: AgentDefinition): void {
  const { registry, config } = definition;
  const tools: { source: string; name: string }[] = [];
  for (const { file, value } of registry.tools) {
    const resolved = checkStatic<AuthoredTool>(file, value, toolProblem);
    if (resolved !== undefined) tools.push({ source: file, name: resolved.name });
  }
  const extensions: { source: string; name: string }[] = [];
  for (const { file, value } of registry.extensions) {
    const resolved = checkStatic<AuthoredExtension>(file, value, extensionProblem);
    if (resolved !== undefined) extensions.push({ source: file, name: resolved.name });
  }
  refuseTwins("tool", tools);
  const codingTools = resolveCodingTools(config.codingTools);
  refuseTwins("extension", [
    ...(codingTools.length > 0 ? [{ source: "pi-durable's coding tools", name: CODING_TOOLS_EXTENSION }] : []),
    { source: "FastAgent's definition extension", name: DEFINITION_EXTENSION },
    ...extensions,
  ]);
  for (const [i, value] of (config.providers ?? []).entries()) {
    checkStatic<Provider>(`${CONFIG_FILE} providers[${i}]`, value, providerProblem);
  }
}

/**
 * Refuse to run while a required secret has no value, naming where it is declared; otherwise build every module with
 * the values it declared, and refuse one that is not what its directory holds.
 */
export function buildDefinition(definition: AgentDefinition, env: NodeJS.ProcessEnv): BuiltDefinition {
  const missing = missingSecrets(codeSecrets(definition), env);
  if (missing.length > 0) {
    throw new Error(`missing required secrets: ${describeSecrets(missing)} (set them in the environment)`);
  }
  const values = (value: unknown): Record<string, string | undefined> =>
    isNeeds(value) ? Object.fromEntries(value.secrets.map(({ name }) => [name, env[name] || undefined])) : {};
  const { registry, config } = definition;
  const tools = registry.tools.map(({ file, value }) => ({
    source: file,
    ...named(built<AuthoredTool>(file, value, values(value), toolProblem)),
  }));
  const extensions = registry.extensions.map(({ file, value }) => ({
    source: file,
    ...named(built<AuthoredExtension>(file, value, values(value), extensionProblem)),
  }));
  refuseTwins("tool", tools);
  const codingTools = resolveCodingTools(config.codingTools);
  refuseTwins("extension", [
    ...(codingTools.length > 0 ? [{ source: "pi-durable's coding tools", name: CODING_TOOLS_EXTENSION }] : []),
    { source: "FastAgent's definition extension", name: DEFINITION_EXTENSION },
    ...extensions,
  ]);
  return {
    tools: tools.map(({ value }) => value),
    extensions: extensions.map(({ value }) => value),
    providers: (config.providers ?? []).map((value, i) =>
      built<Provider>(`${CONFIG_FILE} providers[${i}]`, value, values(value), providerProblem),
    ),
  };
}

/** Build the definition with stand-ins for unset secrets to inspect its shape without requiring runtime credentials. */
export function buildDefinitionShape(definition: AgentDefinition, env: NodeJS.ProcessEnv): BuiltDefinition {
  const values: NodeJS.ProcessEnv = Object.fromEntries(
    definition.inputs.secrets.map(({ name }) => [name, "(no value here)"]),
  );
  for (const [name, value] of Object.entries(env)) if (value) values[name] = value;
  return buildDefinition(definition, values);
}

/** Providers declared by the definition in `agentDir`, built with stand-ins for unset secrets. */
export async function definitionProviders(agentDir: string, env: NodeJS.ProcessEnv): Promise<Provider[]> {
  return buildDefinitionShape(await loadSourceDefinition(agentDir), env).providers;
}

/**
 * Resolve the configured or overridden default model against `models`. Explicit overrides (`chosen`) fail fast when
 * unknown; a missing configured default degrades to `unusableDefault` so `info()` reports why.
 */
export function resolveDefaultModel(
  spec: string | undefined,
  chosen: boolean,
  models: Models,
): { model?: ModelRef; unusableDefault?: NonNullable<AgentInfo["unusableDefault"]> } {
  if (spec === undefined) return {};
  const model = modelRefOf(spec, "the default model");
  if (models.getModel(model.provider, model.modelId) !== undefined) return { model };
  const reason = `no provider "${model.provider}" offers "${model.modelId}"`;
  if (chosen) throw new Error(`unknown model "${spec}": ${reason}`);
  log.warn(`[fastagent] the default model "${spec}" is unusable: ${reason}`);
  return { unusableDefault: { spec, reason } };
}

/** Refuse MCP tools whose exposed names collide with authored tools or extension tools. */
export function assertNoMcpToolConflicts(code: BuiltDefinition, mcpTools: readonly { name: string }[]): void {
  const authoredNames = new Set(
    [...code.tools, ...code.extensions.flatMap((extension) => extension.tools ?? [])].map((tool) => tool.name),
  );
  for (const tool of mcpTools) {
    if (authoredNames.has(tool.name)) throw new Error(`MCP tool ${tool.name} conflicts with an authored tool`);
  }
}
