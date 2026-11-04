/**
 * The configuration of an instance (agent-artifact.md §3.2, §4.2): what the program declares as its `defaults` and
 * its `settings` schema, what an instance sets over them, and the one value they resolve to, each leaf with the place
 * it came from. One JSON Schema describes the shape: it checks the program's defaults and an instance's file alike,
 * and `fastagent build` publishes it as `fastagent.schema.json`.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { type Schema, bool, compile, int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { modelRefOf } from "../../model-ref.ts";
import { INSTANCE_CONFIG_FILE } from "../../paths.ts";
import type { AgentConfig, AgentDefaults } from "./define.ts";
import type { AgentDefinition } from "./definition.ts";

/** What an instance may set over the program's defaults: `fastagent.json`, or the same shape as an object. */
export type InstanceConfig<Settings = unknown> = AgentDefaults<Settings>;

/** An instance configuration and where it is from, said in a refusal and as a value's source. */
export interface InstanceConfigSource {
  values: unknown;
  label: string;
}

const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ModelThinkingLevel[];
const PROGRAM_DEFAULT = "program default";

/** Keys of SPEC.md §8's `InstanceConfig` that a later release reads: refused by name until then, not as unknown. */
const NOT_READ_YET = ["content", "instructions", "skills", "prompts"];

const CONSTANTS = ["name", "description", "extensions", "providers"];
/** Keys that were the program's own before they became defaults. */
const FORMER_CONSTANTS = ["model", "thinkingLevel", "http", "deploy"];

/** The program's `settings` with no property required: an instance gives some of them, the program's defaults the rest. */
function partial(settings: Schema): Schema {
  const { required: _required, ...rest } = settings as Record<string, unknown>;
  return rest as Schema;
}

/** What the program's defaults and an instance's configuration may hold. `settings` is the program's, or none. */
function shape(settings: Schema | undefined) {
  return {
    model: opt(str({ description: 'The default model, "provider/modelId"', minLength: 3 })),
    thinkingLevel: opt(oneOf(THINKING_LEVELS)),
    http: opt(
      obj({
        port: opt(int({ minimum: 0, maximum: 65535, description: "The port a serve listens on" })),
        api: opt(bool({ description: "Whether a serve answers the Agent API under /v1" })),
      }),
    ),
    deploy: opt(
      obj({
        // AWS's own bounds for idleRuntimeSessionTimeout: a value outside them is refused by CloudFormation minutes
        // into `deploy agentcore --run`, after the image build.
        agentcore: opt(obj({ idleTimeoutSeconds: opt(int({ minimum: 60, maximum: 1209600 })) })),
      }),
    ),
    settings: opt(settings === undefined ? obj({}) : partial(settings)),
  };
}

/** The JSON Schema of an instance's `fastagent.json` for a program with `settings`: what `fastagent build` publishes. */
export function instanceConfigSchema(settings: Schema | undefined): Schema {
  return obj({ $schema: opt(str()), ...shape(settings) });
}

/** Refuse `value`, naming `where`, when `schema` does not accept it: each failing path, and why. */
function check(schema: Schema, value: unknown, where: string): void {
  const validator = compile(schema);
  if (validator.check(value)) return;
  const problems = validator
    .errors(value)
    .map(({ path, message }) => `${path === "" ? "(the value)" : path} ${message}`);
  throw new Error(`${where}: ${problems.join("; ")}`);
}

/** Defaults, or an instance's values, in the shape both have; `schemaWhere` names the model's place in a refusal. */
function checkValues(
  values: unknown,
  settings: Schema | undefined,
  where: string,
  shapeOf: (s?: Schema) => Schema,
): void {
  check(shapeOf(settings), values, where);
  const { model } = values as { model?: string };
  if (model !== undefined) modelRefOf(model, `${where}: /model`);
}

/**
 * The program's `fastagent.config.ts` default export, checked: the constants it may hold, its `settings` schema, and
 * its defaults in the shape an instance's configuration has. Without one, no constants and no defaults.
 */
export function checkProgramConfig(config: unknown, file: string): AgentConfig {
  if (config === undefined) return {};
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error(`${file} must default-export defineAgent({ ... })`);
  }
  const { settings, defaults, extensions, providers } = config as AgentConfig;
  const keys = [...CONSTANTS, "settings", "defaults"];
  for (const key of Object.keys(config)) {
    if (keys.includes(key)) continue;
    const moved = FORMER_CONSTANTS.includes(key) ? ': it is a default now, under "defaults"' : "";
    throw new Error(`${file}: unknown key "${key}"${moved} (keys: ${keys.join(", ")})`);
  }
  for (const [key, list] of [
    ["extensions", extensions],
    ["providers", providers],
  ] as const) {
    if (list !== undefined && !Array.isArray(list)) throw new Error(`${file}: "${key}" must be an array`);
  }
  if (settings !== undefined) {
    if ((settings as { type?: unknown } | null)?.type !== "object") {
      throw new Error(`${file}: "settings" must be an object schema (obj({ ... }) from @earendil-works/pi-schema)`);
    }
    try {
      compile(settings);
    } catch (error) {
      throw new Error(`${file}: "settings" is not a JSON Schema: ${(error as Error).message}`, { cause: error });
    }
  }
  if (defaults !== undefined) checkValues(defaults, settings, `${file} defaults`, (s) => obj(shape(s)));
  return config as AgentConfig;
}

/** An instance configuration, checked against the shape of a program with `settings`. */
function checkInstanceConfig({ values, label }: InstanceConfigSource, settings: Schema | undefined): InstanceConfig {
  if (typeof values === "object" && values !== null) {
    const unread = NOT_READ_YET.filter((key) => key in values);
    if (unread.length > 0) throw new Error(`${label}: ${unread.join(", ")} is not read by this FastAgent yet`);
  }
  checkValues(values, settings, label, instanceConfigSchema);
  const { $schema: _schema, ...config } = values as Record<string, unknown>;
  return config as InstanceConfig;
}

/** A `fastagent.json` read: refused when it cannot be read or is not JSON, naming the file. */
export async function readInstanceConfigFile(path: string): Promise<InstanceConfigSource> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`cannot read the instance configuration ${path}: ${(error as Error).message}`, { cause: error });
  }
  try {
    return { values: JSON.parse(text), label: path };
  } catch (error) {
    throw new Error(`${path} is not JSON: ${(error as Error).message}`, { cause: error });
  }
}

/** The `fastagent.json` a development project holds at its root, when it holds one. */
export async function projectInstanceConfig(dir: string): Promise<InstanceConfigSource | undefined> {
  const path = join(dir, INSTANCE_CONFIG_FILE);
  return existsSync(path) ? readInstanceConfigFile(path) : undefined;
}

/** What an open reads of the configuration: the program's defaults with an instance's over them. */
export interface EffectiveConfig {
  model?: string;
  thinkingLevel?: ModelThinkingLevel;
  http?: { port?: number; api?: boolean };
  deploy?: { agentcore?: { idleTimeoutSeconds?: number } };
  settings: Readonly<Record<string, unknown>>;
  /** Where each value is from, by its path (`http.port`, `settings.repo`): "program default", or the instance's label. */
  sources: Readonly<Record<string, string>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Put `layer` over `into`: objects merge, anything else replaces; each leaf written is recorded as from `label`. */
function overlay(
  into: Record<string, unknown>,
  layer: Record<string, unknown>,
  label: string,
  sources: Record<string, string>,
  at = "",
): void {
  for (const [key, value] of Object.entries(layer)) {
    const path = at === "" ? key : `${at}.${key}`;
    if (!isRecord(value)) {
      into[key] = value;
      sources[path] = label;
      continue;
    }
    if (!isRecord(into[key])) {
      into[key] = {};
      delete sources[path];
    }
    overlay(into[key] as Record<string, unknown>, value, label, sources, path);
  }
}

/**
 * The configuration an instance of `definition` opens with: the program's defaults, the instance's over them, the
 * merged settings checked against the program's `settings` schema (a required one no one gave refuses, naming it).
 */
export function resolveConfig(definition: AgentDefinition, instance?: InstanceConfigSource): EffectiveConfig {
  const { defaults, settings } = definition.config;
  const merged: Record<string, unknown> = {};
  const sources: Record<string, string> = {};
  if (defaults !== undefined) {
    checkValues(defaults, settings, `${definition.name} defaults`, (s) => obj(shape(s)));
    overlay(merged, defaults as Record<string, unknown>, PROGRAM_DEFAULT, sources);
  }
  if (instance !== undefined) {
    overlay(merged, checkInstanceConfig(instance, settings) as Record<string, unknown>, instance.label, sources);
  }
  const values = (merged.settings ?? {}) as Record<string, unknown>;
  check(settings ?? obj({}), values, `the settings of ${definition.name}`);
  return { ...merged, settings: values, sources };
}

/** The value at a dotted `path` of `config`. */
export function configValue(config: EffectiveConfig, path: string): unknown {
  let value: unknown = config;
  for (const key of path.split(".")) value = isRecord(value) ? value[key] : undefined;
  return value;
}
