/**
 * A definition assembled onto pi-durable (architecture.md §3): its configuration and generated registry read, its
 * secrets checked as one list, its code built with them, and an Agent opened over pi-ai's built-in models with the
 * text, tools and extensions installed. `dev`, `start` and an embedder call the same function.
 */
import { existsSync } from "node:fs";
import { writeFileAtomic } from "../../atomic-write.ts";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { CredentialStore, ModelThinkingLevel, Provider } from "@earendil-works/pi-ai";
import {
  type Extension,
  type HarnessSettings,
  type ModelRef,
  type Storage,
  type ToolRegistration,
  createRegistry,
  defineExtension,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { loadEnvironment } from "../../content/file.ts";
import type { ResolvedContent } from "../../content/resolve.ts";
import { type DeclaredSecret, describeSecrets, missingSecrets } from "../../declared-secrets.ts";
import { declaredVariables } from "../../environment/declare.ts";
import type { ChannelModule, LongConnectionChannelModule } from "../../channel.ts";
import { channelModuleProblem } from "../../channels/discover.ts";
import { AGENT_CONFIG_FILE as CONFIG_FILE } from "../../paths.ts";
import { readPackageJson } from "../../runtime.ts";
import { DEV_SERVE_ENV } from "../../serving-command.ts";
import { MAX_SCHEDULES, type Schedule, scheduleConfigProblem } from "../../schedule/schedule.ts";
import { modelsOver } from "../models/models.ts";
import { type DurableAgent, openDurableAgent } from "./agent.ts";
import { type AgentConfig, type DefinedSchedule, type Needs, isNeeds } from "./define.ts";
import { GENERATED_DIR, REGISTRY_FILE, REGISTRY_KINDS, type Registry, generateRegistry } from "./registry.ts";
import { definitionSections, readCommands } from "./text.ts";
import { WAKE_EXTENSION, WAKE_TOOLS, wakeExtension } from "./wake.ts";

const SECRETS_MANIFEST_FILE = "secrets.json";
const CONFIG_KEYS = ["name", "description", "model", "thinkingLevel", "extensions", "providers", "http", "deploy"];
const DEFINITION_EXTENSION = "fastagent.definition";
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** An agent package as it was read: where it is, its configuration, and the modules its registry lists. */
export interface AgentDefinition {
  dir: string;
  name: string;
  config: AgentConfig;
  registry: Registry;
}

async function importDefault(path: string, what: string): Promise<unknown> {
  try {
    return ((await import(pathToFileURL(path).href)) as { default?: unknown }).default;
  } catch (error) {
    throw new Error(`${what}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/** An object whose keys are among `keys`, or the refusal naming the one that is not and the ones there are. */
function checkKeys(value: unknown, keys: readonly string[], where: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${where} must be an object`);
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`${where}: unknown key "${key}" (keys: ${keys.join(", ")})`);
  }
}

/** Refuse what a type check would have: Node strips types without checking them, so a typo reaches here. */
function checkConfig(config: unknown, file: string): AgentConfig {
  if (config === undefined) return {};
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error(`${file} must default-export defineAgent({ ... })`);
  }
  checkKeys(config, CONFIG_KEYS, file);
  const { model, thinkingLevel, extensions, providers, http, deploy } = config as AgentConfig;
  if (http !== undefined) {
    checkKeys(http, ["port"], `${file}: "http"`);
    const port = http.port;
    if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
      throw new Error(`${file}: "http.port" must be an integer 0-65535`);
    }
  }
  if (deploy !== undefined) {
    checkKeys(deploy, ["agentcore"], `${file}: "deploy"`);
    if (deploy.agentcore !== undefined) {
      checkKeys(deploy.agentcore, ["idleTimeoutSeconds"], `${file}: "deploy.agentcore"`);
      // AWS's own bounds for idleRuntimeSessionTimeout: a value outside them is refused by CloudFormation minutes
      // into `deploy agentcore --run`, after the image build.
      const idle = deploy.agentcore.idleTimeoutSeconds;
      if (idle !== undefined && (!Number.isInteger(idle) || idle < 60 || idle > 1209600)) {
        throw new Error(`${file}: "deploy.agentcore.idleTimeoutSeconds" must be an integer 60-1209600 (seconds)`);
      }
    }
  }
  if (model !== undefined) modelRefOf(model, `${file}: "model"`);
  if (thinkingLevel !== undefined && !THINKING_LEVELS.includes(thinkingLevel)) {
    throw new Error(`${file}: "thinkingLevel" must be one of ${THINKING_LEVELS.join(", ")}`);
  }
  for (const [key, list] of [
    ["extensions", extensions],
    ["providers", providers],
  ] as const) {
    if (list !== undefined && !Array.isArray(list)) throw new Error(`${file}: "${key}" must be an array`);
  }
  return config as AgentConfig;
}

export function modelRefOf(spec: string, where: string): ModelRef {
  const slash = typeof spec === "string" ? spec.indexOf("/") : -1;
  if (slash < 1 || slash === spec.length - 1) {
    throw new Error(`${where} must be "provider/modelId", got ${JSON.stringify(spec)}`);
  }
  return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
}

/** The agent package's `fastagent.config.ts`, checked; `{}` without one. */
export async function loadConfig(dir: string): Promise<AgentConfig> {
  const configPath = join(dir, CONFIG_FILE);
  return checkConfig(existsSync(configPath) ? await importDefault(configPath, CONFIG_FILE) : undefined, CONFIG_FILE);
}

/** The default model a process here runs with: `--model` > `FASTAGENT_MODEL` > the configuration's `model`. */
export function modelSpecFor(
  config: AgentConfig,
  flag: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return flag ?? (env.FASTAGENT_MODEL || config.model);
}

/** Read the agent package in `dir`: `fastagent.config.ts` (optional) and `.fastagent/registry.ts`, generated first. */
export async function loadDefinition(dir: string): Promise<AgentDefinition> {
  const config = await loadConfig(dir);
  const registryPath = join(dir, GENERATED_DIR, REGISTRY_FILE);
  if (!existsSync(registryPath)) {
    throw new Error(`${GENERATED_DIR}/${REGISTRY_FILE} is missing: generate it from src/ before opening the agent`);
  }
  let registry: Registry;
  try {
    registry = (await import(pathToFileURL(registryPath).href)) as Registry;
  } catch (error) {
    // The registry imports every module, so a module that fails to load (or has no default export) fails here.
    throw new Error(`loading src/ through ${GENERATED_DIR}/${REGISTRY_FILE}: ${(error as Error).message}`, {
      cause: error,
    });
  }
  const packageName = (await readPackageJson(dir)) as { name?: unknown };
  const name = config.name ?? (typeof packageName.name === "string" ? packageName.name : basename(dir));
  return { dir, name, config, registry };
}

/** Every value the definition can hold `Needs` in, with where it is: modules by file, configuration by key. */
function declarers(definition: AgentDefinition): { source: string; value: unknown }[] {
  return [
    ...REGISTRY_KINDS.flatMap((kind) => definition.registry[kind].map(({ file, value }) => ({ source: file, value }))),
    ...(definition.config.extensions ?? []).map((value, i) => ({ source: `${CONFIG_FILE} extensions[${i}]`, value })),
    ...(definition.config.providers ?? []).map((value, i) => ({ source: `${CONFIG_FILE} providers[${i}]`, value })),
  ];
}

/** The secrets the definition declares, wherever: its code's `needs`, and `context.json`'s command variables. */
export function definitionSecrets(definition: AgentDefinition): DeclaredSecret[] {
  return [
    ...declarers(definition).flatMap(({ source, value }) =>
      isNeeds(value) ? value.secrets.map((secret) => ({ ...secret, source })) : [],
    ),
    ...declaredVariables(loadEnvironment(definition.dir)),
  ];
}

/**
 * The list a person deploying or running the agent reads instead of its code (`.fastagent/secrets.json`): each name
 * once, what it is for, whether the agent runs without it, and where it is declared.
 */
export function secretsManifest(definition: AgentDefinition) {
  const byName = new Map<string, { name: string; description?: string; optional: boolean; declaredIn: string[] }>();
  for (const secret of definitionSecrets(definition)) {
    const entry = byName.get(secret.name) ?? { name: secret.name, optional: true, declaredIn: [] };
    entry.optional &&= secret.optional === true;
    entry.declaredIn.push(secret.source);
    if (entry.description === undefined && secret.description !== undefined) entry.description = secret.description;
    byName.set(secret.name, entry);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Generate the registry, read the definition, and write its secrets manifest beside the registry. */
export async function prepareDefinition(dir: string): Promise<AgentDefinition> {
  await generateRegistry(dir);
  const definition = await loadDefinition(dir);
  writeFileAtomic(
    join(dir, GENERATED_DIR, SECRETS_MANIFEST_FILE),
    `${JSON.stringify(secretsManifest(definition), null, 2)}\n`,
    undefined,
    true,
  );
  return definition;
}

/** What one value is once its secrets are supplied, or why it is not what its place holds. */
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
  const tool = value as Partial<ToolRegistration> | null;
  return typeof tool?.name === "string" &&
    typeof tool.description === "string" &&
    typeof tool.parameters === "object" &&
    typeof tool.execute === "function"
    ? undefined
    : "must default-export a tool (defineTool from @earendil-works/pi-durable), or needs(...) around one";
};
const extensionProblem = (value: unknown): string | undefined =>
  typeof (value as Partial<Extension> | null)?.name === "string"
    ? undefined
    : "must be an extension (defineExtension from @earendil-works/pi-durable), or needs(...) around one";
const providerProblem = (value: unknown): string | undefined =>
  typeof (value as Partial<Provider> | null)?.id === "string" ? undefined : "must be a pi-ai provider (createProvider)";
const channelProblem = channelModuleProblem;
const scheduleProblem = (value: unknown): string | undefined =>
  (value as Partial<DefinedSchedule> | null)?.kind !== "fastagent.schedule"
    ? "must default-export defineSchedule({ ... }), or needs(...) around one"
    : scheduleConfigProblem(value as DefinedSchedule);

/** The definition's code, built with the values of the secrets it declares. */
export interface BuiltDefinition {
  tools: ToolRegistration[];
  extensions: Extension[];
  providers: Provider[];
  /** By name, the file's: what a serve mounts or connects. */
  channels: Map<string, ChannelModule | LongConnectionChannelModule>;
  /** What the scheduler fires, each named by its file. */
  schedules: Schedule[];
}

/**
 * Refuse to run while a required secret has no value, naming where it is declared; otherwise build every module with
 * the values it declared, and refuse one that is not what its directory holds.
 */
export function buildDefinition(definition: AgentDefinition, env: NodeJS.ProcessEnv = process.env): BuiltDefinition {
  const missing = missingSecrets(definitionSecrets(definition), env);
  if (missing.length > 0) {
    throw new Error(`missing required secrets: ${describeSecrets(missing)} (set them in the environment)`);
  }
  const values = (value: unknown): Record<string, string | undefined> =>
    isNeeds(value) ? Object.fromEntries(value.secrets.map(({ name }) => [name, env[name] || undefined])) : {};
  const { registry, config } = definition;
  const tools = registry.tools.map(({ file, value }) => ({
    source: file,
    ...named(built<ToolRegistration>(file, value, values(value), toolProblem)),
  }));
  const extensions = [
    ...registry.extensions.map(({ file, value }) => ({
      source: file,
      ...named(built<Extension>(file, value, values(value), extensionProblem)),
    })),
    ...(config.extensions ?? []).map((value, i) => {
      const source = `${CONFIG_FILE} extensions[${i}]`;
      return { source, ...named(built<Extension>(source, value, values(value), extensionProblem)) };
    }),
  ];
  const channels = registry.channels.map(({ file, name, value }) => ({
    source: file,
    name,
    value: built<ChannelModule | LongConnectionChannelModule>(file, value, values(value), channelProblem),
  }));
  const schedules = registry.schedules.map(({ file, name, value }) => ({
    source: file,
    name,
    value: built<DefinedSchedule>(file, value, values(value), scheduleProblem),
  }));
  refuseTwins("tool", tools);
  // pi-durable replaces an extension installed under a name already taken, its tools and sections with it.
  refuseTwins("extension", [
    { source: "pi-durable's coding tools", name: CodingTools.name },
    { source: "FastAgent's definition extension", name: DEFINITION_EXTENSION },
    { source: "FastAgent's wake tools", name: WAKE_EXTENSION },
    ...extensions,
  ]);
  refuseTwins("channel", channels);
  refuseTwins("schedule", schedules);
  if (schedules.length > MAX_SCHEDULES) {
    throw new Error(`${schedules.length} schedules in src/schedules/: an agent runs at most ${MAX_SCHEDULES}`);
  }
  return {
    tools: tools.map(({ value }) => value),
    extensions: extensions.map(({ value }) => value),
    providers: (config.providers ?? []).map((value, i) =>
      built<Provider>(`${CONFIG_FILE} providers[${i}]`, value, values(value), providerProblem),
    ),
    channels: new Map(channels.map(({ name, value }) => [name, value])),
    schedules: schedules.map(({ name, value: { kind: _kind, ...config } }) => ({ name, ...config })),
  };
}

/**
 * The definition's code built only to read its shape (which channels, with which ingress, which schedules, which
 * providers): a declared secret `env` holds no value for has a stand-in, since the shape must not depend on whether
 * this machine holds the values. Whatever a build refuses, this refuses too.
 */
export function buildDefinitionShape(definition: AgentDefinition, env: NodeJS.ProcessEnv): BuiltDefinition {
  const values: NodeJS.ProcessEnv = Object.fromEntries(
    definitionSecrets(definition).map(({ name }) => [name, "(no value here)"]),
  );
  for (const [name, value] of Object.entries(env)) if (value) values[name] = value;
  return buildDefinition(definition, values);
}

/**
 * The providers of the definition in `agentDir`, for a command that reads models without serving (`models`, `login`,
 * the first-run picker): with the values `env` holds and stand-ins for the rest, so listing a model or signing in to
 * it needs no secret the serve would. Without these a provider in code, or one replacing a built-in's id, would be
 * unknown there, or verified against the built-in's endpoint.
 */
export async function definitionProviders(agentDir: string, env: NodeJS.ProcessEnv = process.env): Promise<Provider[]> {
  return buildDefinitionShape(await prepareDefinition(agentDir), env).providers;
}

const named = <T extends { name: string }>(value: T) => ({ name: value.name, value });

/** Refuse two of a kind under one name: whichever is installed or kept last would silently stand in for the other. */
function refuseTwins(kind: string, entries: readonly { source: string; name: string }[]): void {
  const first = new Map<string, string>();
  for (const { source, name } of entries) {
    const earlier = first.get(name);
    if (earlier !== undefined) throw new Error(`${earlier} and ${source} both define the ${kind} "${name}"`);
    first.set(name, source);
  }
}

export interface OpenAgentOptions {
  storage: Storage;
  /** What the agent works on and knows (`context.json`'s content), resolved for this instance. */
  content?: readonly ResolvedContent[];
  /** The definition's code, built once with its secrets (`buildDefinition`). */
  code: BuiltDefinition;
  /** Where `login` keeps provider credentials: the machine's in development, the instance's when deployed. */
  credentials: CredentialStore;
  /** What a deployment sets over the definition's defaults (a flag, `FASTAGENT_MODEL`). */
  model?: string;
  thinkingLevel?: ModelThinkingLevel;
  settings?: HarnessSettings;
  /** Where the instance's state is: given by a serve, whose scheduler fires the wake-ups `wake` keeps there. */
  stateRoot?: string;
}

/** Open the definition as an Agent: pi-ai's built-in models and the definition's providers, the coding tools, then its own. */
export async function openAgent(definition: AgentDefinition, options: OpenAgentOptions): Promise<DurableAgent> {
  const { dir, config } = definition;
  const { code } = options;
  const models = modelsOver(options.credentials, code.providers);
  const spec = options.model ?? config.model;
  const model = spec === undefined ? undefined : modelRefOf(spec, "the default model");
  if (model !== undefined && models.getModel(model.provider, model.modelId) === undefined) {
    throw new Error(`unknown model "${spec}": no provider "${model.provider}" offers "${model.modelId}"`);
  }
  const ownWake = [...code.tools, ...code.extensions.flatMap((extension) => extension.tools ?? [])].some(({ name }) =>
    WAKE_TOOLS.includes(name),
  );
  const registry = createRegistry();
  registry.install(CodingTools);
  // After the coding tools, so a tool of the definition's own with one of their names replaces it.
  registry.install(
    defineExtension({
      name: DEFINITION_EXTENSION,
      sections: definitionSections(dir, options.content ?? [], { wake: ownWake || options.stateRoot !== undefined }),
      tools: code.tools,
    }),
  );
  for (const extension of code.extensions) registry.install(extension);
  if (options.stateRoot !== undefined && !ownWake) registry.install(wakeExtension(options.stateRoot));
  const thinkingLevel = options.thinkingLevel ?? config.thinkingLevel;
  return openDurableAgent({
    storage: options.storage,
    models,
    registry,
    name: definition.name,
    ...(config.description === undefined ? {} : { description: config.description }),
    ...(model === undefined ? {} : { model }),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    // What the agent runs is not `dev`'s own serving, even when `dev` is what runs the agent.
    env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? dir, shellEnv: { [DEV_SERVE_ENV]: undefined } }),
    commands: () => readCommands(dir),
  });
}
