/**
 * A definition assembled onto pi-durable: a source project read as a definition, its secrets
 * checked as one list, its code built with them, and an Agent opened over pi-ai's built-in models with the
 * text, tools and extensions installed. `dev`, `start` and an embedder call the same function.
 */
import { basename, resolve } from "node:path";
import type { ModelThinkingLevel, Models, Provider } from "@earendil-works/pi-ai";
import {
  type Extension,
  type HarnessSettings,
  type Storage,
  type ToolRegistration,
  createRegistry,
  defineExtension,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { ResolvedContent } from "../../content/resolve.ts";
import { describeSecrets, missingSecrets } from "../../declared-secrets.ts";
import type { ChannelModule, LongConnectionChannelModule } from "../../channel.ts";
import { channelIngress, channelModuleProblem } from "../../channels/discover.ts";
import { AGENT_CONFIG_FILE as CONFIG_FILE } from "../../paths.ts";
import { loadRawProgramConfig } from "../../program-config.ts";
import { readPackageJson } from "../../runtime.ts";
import { fastagentVersion } from "../../version.ts";
import { InstanceExecutionEnv } from "./execution-env.ts";
import { instanceName } from "../../instance-name.ts";
import type { RunsAs } from "../../serving-command.ts";
import type { AgentInfo, ModelRef } from "../../agent-api.ts";
import { log } from "../../log.ts";
import { modelRefOf } from "../../model-ref.ts";
import { MAX_SCHEDULES, type Schedule, scheduleConfigProblem } from "../../schedule/schedule.ts";
import { type DurableAgent, type Unfinished, openDurableAgent } from "./agent.ts";
import { type AgentConfig, type DefinedSchedule, type Needs, isByIngress, isNeeds } from "./define.ts";
import {
  type EffectiveConfig,
  type InstanceConfigSource,
  agentPresentation,
  checkProgramConfig,
  devInstanceConfig,
} from "./config.ts";
import {
  type AgentDefinition,
  DEFINITION_FORMAT,
  type IngressConfig,
  chosenIngress,
  codeSecrets,
  defineDefinition,
} from "./definition.ts";
import { importRegistry } from "./registry.ts";
import { definitionSections, readCommands } from "./text.ts";
import { type TextSources, programText } from "./text-sources.ts";
import { WAKE_EXTENSION, WAKE_TOOLS, wakeExtension } from "./wake.ts";

const DEFINITION_EXTENSION = "fastagent.definition";

/** The agent package's `fastagent.config.ts`, checked; `{}` without one. */
async function loadConfig(dir: string): Promise<AgentConfig> {
  const { value, file } = await loadRawProgramConfig(dir);
  return checkProgramConfig(value, file);
}

/** The default model a process here runs with: `--model` > `FASTAGENT_MODEL` > the configuration's `model`. */
export function modelSpecFor(
  config: Pick<EffectiveConfig, "model">,
  flag: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return flag ?? (env.FASTAGENT_MODEL || config.model);
}

/** A definition and the instance configuration it opens with: what a command resolves before it opens an agent. */
export interface Project {
  definition: AgentDefinition;
  instance?: InstanceConfigSource;
}

/** The development project in `dir`, as `dev` opens it: its source and the `fastagent.json` at its root, if any. */
export async function loadDevProject(dir: string): Promise<Project> {
  const definition = await loadSourceDefinition(dir);
  const instance = await devInstanceConfig(dir);
  return instance === undefined ? { definition } : { definition, instance };
}

/** The source project in `dir` as a definition: `fastagent.config.ts` (optional) and the modules of `src/`. */
export async function loadSourceDefinition(directory: string): Promise<AgentDefinition> {
  // Absolute, since the prompt names the definition's files by it and the agent's tools resolve a relative path against
  // the agent's own working directory, which is this one.
  const dir = resolve(directory);
  const config = await loadConfig(dir);
  const registry = await importRegistry(dir);
  const pkg = (await readPackageJson(dir)) as { name?: unknown; version?: unknown; description?: unknown };
  return defineDefinition({
    format: DEFINITION_FORMAT,
    builtWith: await fastagentVersion(),
    name: typeof pkg.name === "string" ? pkg.name : basename(dir),
    // A source project need not be published, so it need not have a version.
    version: typeof pkg.version === "string" ? pkg.version : "0.0.0",
    ...(typeof pkg.description === "string" && pkg.description.trim() !== "" ? { description: pkg.description } : {}),
    source: true,
    dir,
    config,
    registry,
  });
}

/** What one value is once its secrets are supplied, or why it is not what its place holds. */
function built<T>(
  source: string,
  value: unknown,
  values: Record<string, string | undefined>,
  settings: Readonly<Record<string, unknown>>,
  accept: (v: unknown) => string | undefined,
): T {
  const resolved = isNeeds(value) ? (value as Needs<unknown>).build(values, settings) : value;
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

/** What a build reads of an instance's configuration: its settings, and how its channels receive. */
export interface BuildConfig extends IngressConfig {
  settings: Readonly<Record<string, unknown>>;
}

/**
 * The channel `name` as `config` has it: the way it chooses of one that receives either way, which must build the
 * module that way receives with; or the one module there is, which must receive the way `config` names, when it names
 * one.
 */
function chosenChannel(
  file: string,
  name: string,
  value: unknown,
  config: BuildConfig,
  build: (value: unknown, source: string) => ChannelModule | LongConnectionChannelModule,
): ChannelModule | LongConnectionChannelModule {
  const shapeOf = (module: ChannelModule | LongConnectionChannelModule) =>
    channelIngress(module) === "webhook" ? "webhook" : "connection";
  const by = (way: "webhook" | "connection") => (way === "webhook" ? "webhook" : "a connection it opens");
  if (isByIngress(value)) {
    const way = chosenIngress(config, name);
    const module = build(value[way], `${file} (byIngress ${way})`);
    if (shapeOf(module) !== way) {
      throw new Error(`${file}: its ${way} way builds a channel that receives by ${by(shapeOf(module))}`);
    }
    return module;
  }
  const module = build(value, file);
  const named = config.channels?.[name]?.ingress;
  if (named !== undefined && shapeOf(module) !== named) {
    throw new Error(
      `channels.${name}.ingress is "${named}", and ${file} receives only by ${by(shapeOf(module))}: default-export ` +
        `byIngress({ webhook, connection }) from it to let an instance choose`,
    );
  }
  return module;
}

/**
 * Refuse to run while a required secret has no value, naming where it is declared; otherwise build every module with
 * the values it declared, and refuse one that is not what its directory holds. A channel that receives either way is
 * built the way `config` chooses, and only that way's secrets are asked for.
 */
export function buildDefinition(
  definition: AgentDefinition,
  env: NodeJS.ProcessEnv,
  instance: BuildConfig = { settings: {} },
): BuiltDefinition {
  const { settings } = instance;
  const missing = missingSecrets(codeSecrets(definition, instance), env);
  if (missing.length > 0) {
    throw new Error(`missing required secrets: ${describeSecrets(missing)} (set them in the environment)`);
  }
  const values = (value: unknown): Record<string, string | undefined> =>
    isNeeds(value) ? Object.fromEntries(value.secrets.map(({ name }) => [name, env[name] || undefined])) : {};
  const { registry, config } = definition;
  const tools = registry.tools.map(({ file, value }) => ({
    source: file,
    ...named(built<ToolRegistration>(file, value, values(value), settings, toolProblem)),
  }));
  const extensions = [
    ...registry.extensions.map(({ file, value }) => ({
      source: file,
      ...named(built<Extension>(file, value, values(value), settings, extensionProblem)),
    })),
  ];
  const channels = registry.channels.map(({ file, name, value }) => ({
    source: file,
    name,
    value: chosenChannel(file, name, value, instance, (way, source) =>
      built<ChannelModule | LongConnectionChannelModule>(source, way, values(way), settings, channelProblem),
    ),
  }));
  const schedules = registry.schedules.map(({ file, name, value }) => ({
    source: file,
    name,
    value: built<DefinedSchedule>(file, value, values(value), settings, scheduleProblem),
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
      built<Provider>(`${CONFIG_FILE} providers[${i}]`, value, values(value), settings, providerProblem),
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
export function buildDefinitionShape(
  definition: AgentDefinition,
  env: NodeJS.ProcessEnv,
  config: BuildConfig = {
    settings: definition.config.defaults?.settings ?? {},
    ...(definition.config.defaults?.channels === undefined ? {} : { channels: definition.config.defaults.channels }),
  },
): BuiltDefinition {
  const values: NodeJS.ProcessEnv = Object.fromEntries(
    definition.inputs.secrets.map(({ name }) => [name, "(no value here)"]),
  );
  for (const [name, value] of Object.entries(env)) if (value) values[name] = value;
  return buildDefinition(definition, values, config);
}

/**
 * The providers of the definition in `agentDir`, for a command that reads models without serving (`models`, `login`,
 * the first-run picker): with the values `env` holds and stand-ins for the rest, so listing a model or signing in to
 * it needs no secret the serve would. Without these a provider in code, or one replacing a built-in's id, would be
 * unknown there, or verified against the built-in's endpoint.
 */
export async function definitionProviders(agentDir: string, env: NodeJS.ProcessEnv): Promise<Provider[]> {
  return buildDefinitionShape(await loadSourceDefinition(agentDir), env).providers;
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

export interface AssembleAgentOptions {
  storage: Storage;
  /** Who runs the instance, as far as the prompt says where the agent runs (deployed, on AgentCore). */
  runsAs: RunsAs;
  /** What the agent works on (`fastagent.config.ts` / `fastagent.json`), resolved for this instance. */
  content?: readonly ResolvedContent[];
  /** The instance's name (`instanceName`): what `info().name` reports. Default: the definition's, as one segment. */
  name?: string;
  /** The agent's working directory: the definition's own, unless the instance is elsewhere. */
  workdir?: string;
  /** The definition's code, built once with its secrets (`buildDefinition`). */
  code: BuiltDefinition;
  /** The configuration this instance opens with (`resolveConfig`). */
  config: EffectiveConfig;
  /** The text it reads for each message (`openText`). Default: the program's own. */
  text?: TextSources;
  mcpTools?: ToolRegistration[];
  /**
   * pi-ai's built-ins and the definition's providers over the instance's credentials, lists refreshed: the model
   * environment's (environment.ts), so the Agent runs on the lists its startup report reads.
   */
  models: Models;
  /** Why the lists of {@link models} are not current, when they are not: said with a default model none offers. */
  catalogProblem?: string;
  /** What a deployment sets over the definition's defaults (a flag, `FASTAGENT_MODEL`). */
  model?: string;
  thinkingLevel?: ModelThinkingLevel;
  settings?: HarnessSettings;
  /** Where the instance's state is: given by a serve, whose scheduler fires the wake-ups `wake` keeps there. */
  stateRoot?: string;
  /** Whether that scheduler runs now: an app's `openAgent` runs one only while it serves. Default always. */
  wakeTicking?: () => boolean;
  unfinished?: Unfinished;
  /** The whole environment of the processes the agent starts (child-env.ts): nothing of this process's is added. */
  processEnv: Readonly<Record<string, string>>;
}

/**
 * The default model `spec` names, or why this instance cannot answer with it. A model chosen now (`chosen`: a flag,
 * `FASTAGENT_MODEL`) is strict, so a typo fails at the open. A configured default may have left the catalog since it was
 * written (a provider retires it, a catalog update renames it); the instance still opens, with no default.
 */
function resolveDefaultModel(
  spec: string | undefined,
  chosen: boolean,
  models: Models,
  catalogProblem: string | undefined,
): { model?: ModelRef; unusableDefault?: NonNullable<AgentInfo["unusableDefault"]> } {
  if (spec === undefined) return {};
  const model = modelRefOf(spec, "the default model");
  if (models.getModel(model.provider, model.modelId) !== undefined) return { model };
  const stale = catalogProblem === undefined ? "" : `, and ${catalogProblem}`;
  const reason = `no provider "${model.provider}" offers "${model.modelId}"${stale}`;
  if (chosen) throw new Error(`unknown model "${spec}": ${reason}`);
  log.warn(`[fastagent] the default model "${spec}" is unusable: ${reason}`);
  return { unusableDefault: { spec, reason } };
}

/** Open the definition as an Agent over `models`: the coding tools, then its own. */
export async function assembleAgent(definition: AgentDefinition, options: AssembleAgentOptions): Promise<DurableAgent> {
  const { dir } = definition;
  const { code, models, config } = options;
  const text = options.text ?? programText(dir);
  const spec = options.model ?? config.model;
  const { model, unusableDefault } = resolveDefaultModel(
    spec,
    options.model !== undefined,
    models,
    options.catalogProblem,
  );
  const ownWake = [...code.tools, ...code.extensions.flatMap((extension) => extension.tools ?? [])].some(({ name }) =>
    WAKE_TOOLS.includes(name),
  );
  const authoredNames = new Set(
    [...code.tools, ...code.extensions.flatMap((extension) => extension.tools ?? [])].map((tool) => tool.name),
  );
  for (const tool of options.mcpTools ?? []) {
    if (authoredNames.has(tool.name)) throw new Error(`MCP tool ${tool.name} conflicts with an authored tool`);
  }
  const registry = createRegistry();
  registry.install(CodingTools);
  // After the coding tools, so a tool of the definition's own with one of their names replaces it.
  registry.install(
    defineExtension({
      name: DEFINITION_EXTENSION,
      sections: definitionSections(dir, options.content ?? [], {
        wake: ownWake || options.stateRoot !== undefined,
        runsAs: options.runsAs,
        workdir: options.workdir ?? dir,
        text,
        source: definition.source === true,
      }),
      tools: [...code.tools, ...(options.mcpTools ?? [])],
    }),
  );
  for (const extension of code.extensions) registry.install(extension);
  if (options.stateRoot !== undefined && !ownWake) {
    registry.install(
      wakeExtension(options.stateRoot, options.wakeTicking === undefined ? {} : { ticking: options.wakeTicking }),
    );
  }
  const thinkingLevel = options.thinkingLevel ?? config.thinkingLevel;
  return openDurableAgent({
    storage: options.storage,
    models,
    registry,
    name: options.name ?? instanceName(definition.name),
    ...agentPresentation(definition, config),
    ...(model === undefined ? {} : { model }),
    ...(unusableDefault === undefined ? {} : { unusableDefault }),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    ...(options.unfinished === undefined ? {} : { unfinished: options.unfinished }),
    // What the agent runs is not `dev`'s own serving, even when `dev` is what runs the agent.
    env: ({ cwd }) => new InstanceExecutionEnv({ cwd: cwd ?? options.workdir ?? dir, processEnv: options.processEnv }),
    commands: () => readCommands(text),
  });
}
