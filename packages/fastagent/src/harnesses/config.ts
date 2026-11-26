/** The program's `fastagent.config.ts`, checked: the one place an agent's settings are written. */
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { type Schema, arr, compile, int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { declareServers } from "../mcp/config.ts";
import { modelRefOf } from "../model-ref.ts";
import { isNeeds } from "../needs.ts";
import { decodeRuntimeCliEnv } from "../process-env.ts";
import {
  CODING_TOOL_NAMES,
  HARNESS_NAMES,
  SANDBOX_MODES,
  type AgentConfig,
  type CodingToolName,
  type CodingToolsConfig,
  type HarnessName,
  type SandboxMode,
} from "./define.ts";
import type { AgentDefinition } from "../definition/definition.ts";

const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ModelThinkingLevel[];
const MAX_STARTERS = 6;
const MAX_STARTER_LENGTH = 200;

const KEYS = [
  "model",
  "thinkingLevel",
  "harness",
  "sandbox",
  "codingTools",
  "maxSteps",
  "starters",
  "providers",
  "mcpServers",
];
const KEY_SET = new Set<string>(KEYS);
const CODING_TOOL_SET = new Set<string>(CODING_TOOL_NAMES);
const HARNESS_SET = new Set<string>(HARNESS_NAMES);
const SANDBOX_SET = new Set<string>(SANDBOX_MODES);

export const HARNESS_ENV = "FASTAGENT_HARNESS";
export const SANDBOX_ENV = "FASTAGENT_SANDBOX";

/** Optional external runtime packages required by non-default harnesses. */
export const OPTIONAL_HARNESS_PACKAGES = {
  dsh: "@fastagent-sh/harness-dsh",
} as const satisfies Partial<Record<HarnessName, string>>;

/** Optional runtime package required by `harness`, or `undefined` for the built-in `pi-durable` harness. */
export function harnessPackage(harness: HarnessName | undefined): string | undefined {
  return harness === "dsh" ? OPTIONAL_HARNESS_PACKAGES.dsh : undefined;
}

export interface HarnessSelection {
  readonly harness: HarnessName;
  readonly sandbox?: SandboxMode;
}

interface HarnessCapabilities {
  readonly extensions: boolean;
  readonly sandbox: boolean;
}

const HARNESS_CAPABILITIES: Record<HarnessName, HarnessCapabilities> = {
  "pi-durable": { extensions: true, sandbox: false },
  dsh: { extensions: false, sandbox: true },
};

const SANDBOX_HARNESSES = HARNESS_NAMES.filter((name) => HARNESS_CAPABILITIES[name].sandbox);

/**
 * Resolve the effective harness and sandbox posture with precedence:
 * explicit override (CLI flag / openAgent option) > environment (`FASTAGENT_HARNESS` / `FASTAGENT_SANDBOX`) >
 * `fastagent.config.ts` > defaults (`"pi-durable"`, and `"workspace"` when `"dsh"`).
 */
export function resolveHarnessSelection(
  config: Pick<AgentConfig, "harness" | "sandbox">,
  overrides: { readonly harness?: string; readonly sandbox?: string } = {},
  env?: Readonly<Record<string, string | undefined>>,
): HarnessSelection {
  const envHarness = env === undefined ? decodeRuntimeCliEnv().harness : env[HARNESS_ENV];
  const envSandbox = env === undefined ? decodeRuntimeCliEnv().sandbox : env[SANDBOX_ENV];
  const rawHarness = overrides.harness ?? (envHarness || config.harness) ?? "pi-durable";
  if (!HARNESS_SET.has(rawHarness)) {
    throw new Error(`unknown harness ${JSON.stringify(rawHarness)} (allowed: ${HARNESS_NAMES.join(", ")})`);
  }
  const harness = rawHarness as HarnessName;
  const rawSandbox = overrides.sandbox ?? (envSandbox || config.sandbox);
  if (rawSandbox !== undefined && !SANDBOX_SET.has(rawSandbox)) {
    throw new Error(`unknown sandbox mode ${JSON.stringify(rawSandbox)} (allowed: ${SANDBOX_MODES.join(", ")})`);
  }
  if (!HARNESS_CAPABILITIES[harness].sandbox) {
    if (rawSandbox !== undefined) {
      throw new Error(
        `sandbox (${JSON.stringify(rawSandbox)}) requires harness: ${SANDBOX_HARNESSES.map((name) => JSON.stringify(name)).join(" or ")}`,
      );
    }
    return { harness };
  }
  return { harness, sandbox: (rawSandbox as SandboxMode | undefined) ?? "workspace" };
}

/**
 * Pure harness compatibility diagnostics shared across runtime startup (`serving.ts`), read-only inspection
 * (`fastagent info`), builds (`fastagent build`), and deploy preflight (`fastagent deploy check`).
 */
export function diagnoseHarnessCompatibility(
  definition: Pick<AgentDefinition, "registry">,
  selection: HarnessSelection,
  options?: {
    /** Built extensions when available (exact runtime names, including `needs(...)` factories). */
    readonly extensions?: readonly { readonly name: string }[];
    /** Override capability from a dynamically loaded `HarnessProvider.supportsExtensions`. */
    readonly supportsExtensions?: boolean;
  },
): readonly string[] {
  const supportsExtensions = options?.supportsExtensions ?? HARNESS_CAPABILITIES[selection.harness].extensions;
  if (supportsExtensions) return [];
  const names =
    options?.extensions !== undefined
      ? options.extensions.map((ext) => ext.name)
      : definition.registry.extensions.map((entry) => {
          if (!isNeeds(entry.value) && typeof (entry.value as { name?: unknown } | null)?.name === "string") {
            return (entry.value as { name: string }).name;
          }
          return entry.file;
        });
  if (names.length === 0) return [];
  return [
    `skipping pi-durable extensions on harness "${selection.harness}": ${names.join(", ")} (portable tools belong in src/tools/)`,
  ];
}

/** Resolve `codingTools` from config into the concrete list of built-in coding tools to install. */
export function resolveCodingTools(setting: CodingToolsConfig | undefined): readonly CodingToolName[] {
  if (setting === undefined || setting === true) return CODING_TOOL_NAMES;
  if (setting === false) return [];
  return setting;
}

function checkCodingTools(value: unknown, file: string): void {
  if (value === undefined || typeof value === "boolean") return;
  if (!Array.isArray(value)) {
    throw new Error(`${file}: "codingTools" must be a boolean or an array of (${CODING_TOOL_NAMES.join(", ")})`);
  }
  const invalidIndex = value.findIndex((item) => typeof item !== "string" || !CODING_TOOL_SET.has(item));
  if (invalidIndex !== -1) {
    throw new Error(
      `${file}: unknown coding tool ${JSON.stringify(value[invalidIndex])} (allowed: ${CODING_TOOL_NAMES.join(", ")})`,
    );
  }
  const duplicate = (value as readonly string[]).find((item, index, list) => list.indexOf(item) !== index);
  if (duplicate !== undefined) {
    throw new Error(`${file}: duplicate coding tool "${duplicate}"`);
  }
}

/** The keys whose values are plain data; `providers` and `mcpServers` are checked by their own readers. */
const DATA: Schema = obj({
  model: opt(str({ description: 'The default model, "provider/modelId"', minLength: 3 })),
  thinkingLevel: opt(oneOf(THINKING_LEVELS)),
  maxSteps: opt(int({ description: "Maximum model steps per turn", minimum: 1 })),
  starters: opt(
    arr(str({ maxLength: MAX_STARTER_LENGTH, pattern: "\\S" }), {
      description: "Example first messages a client may offer as drafts",
      maxItems: MAX_STARTERS,
    }),
  ),
});

/** The program's `fastagent.config.ts` default export, checked; `{}` without one. */
export function checkProgramConfig(config: unknown, file: string): AgentConfig {
  if (config === undefined) return {};
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error(`${file} must default-export defineAgent({ ... })`);
  }
  const unknownKey = Object.keys(config).find((key) => !KEY_SET.has(key));
  if (unknownKey !== undefined) {
    const hint =
      unknownKey === "defaults"
        ? ": its keys are top-level now (model, thinkingLevel, starters)"
        : unknownKey === "extensions"
          ? ": an extension is a module of src/extensions/ that default-exports it, whether written there or imported from a package"
          : "";
    throw new Error(`${file}: unknown key "${unknownKey}"${hint} (keys: ${KEYS.join(", ")})`);
  }
  const { model, thinkingLevel, harness, sandbox, codingTools, maxSteps, starters, providers, mcpServers } =
    config as AgentConfig;
  const validator = compile(DATA);
  const data = { model, thinkingLevel, maxSteps, starters };
  if (!validator.check(data)) {
    const problems = validator
      .errors(data)
      .map(({ path, message }) => `${path === "" ? "(the value)" : path} ${message}`);
    throw new Error(`${file}: ${problems.join("; ")}`);
  }
  if (harness !== undefined && (typeof harness !== "string" || !HARNESS_SET.has(harness))) {
    throw new Error(`${file}: unknown harness ${JSON.stringify(harness)} (allowed: ${HARNESS_NAMES.join(", ")})`);
  }
  if (sandbox !== undefined && (typeof sandbox !== "string" || !SANDBOX_SET.has(sandbox))) {
    throw new Error(`${file}: unknown sandbox mode ${JSON.stringify(sandbox)} (allowed: ${SANDBOX_MODES.join(", ")})`);
  }
  if (sandbox !== undefined && !HARNESS_CAPABILITIES[harness ?? "pi-durable"].sandbox) {
    throw new Error(
      `${file}: "sandbox" requires harness: ${SANDBOX_HARNESSES.map((name) => JSON.stringify(name)).join(" or ")}`,
    );
  }
  checkCodingTools(codingTools, file);
  if (model !== undefined) modelRefOf(model, `${file}: /model`);
  if (providers !== undefined && !Array.isArray(providers)) throw new Error(`${file}: "providers" must be an array`);
  if (mcpServers !== undefined) declareServers(mcpServers, file);
  return config as AgentConfig;
}

/** What `info()` reports of who the agent is: the package's name and description, and its starters. */
export function agentPresentation(definition: AgentDefinition): {
  agent: { name: string; description?: string };
  starters?: readonly string[];
} {
  return {
    agent: {
      name: definition.name,
      ...(definition.description === undefined ? {} : { description: definition.description }),
    },
    ...(definition.config.starters === undefined ? {} : { starters: definition.config.starters }),
  };
}
