/** The program's `fastagent.config.ts`, checked: the one place an agent's settings are written. */
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { declareServers } from "../mcp/config.ts";
import { modelRefOf } from "../model-ref.ts";
import { decodeRuntimeCliEnv } from "../process-env.ts";
import {
  CODING_TOOL_NAMES,
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
const THINKING_LEVEL_SET = new Set<string>(THINKING_LEVELS);
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
const SANDBOX_SET = new Set<string>(SANDBOX_MODES);
const HARNESS_IDENTIFIER = /^[a-z][a-z0-9-]*$/;

export const HARNESS_ENV = "FASTAGENT_HARNESS";
export const SANDBOX_ENV = "FASTAGENT_SANDBOX";

/** External runtime package required by `harness`, or `undefined` for the built-in `pi-durable` harness. */
export function harnessPackage(harness: HarnessName | undefined): string | undefined {
  if (harness === undefined || harness === "pi-durable") return undefined;
  return HARNESS_IDENTIFIER.test(harness) ? `@fastagent-sh/harness-${harness}` : undefined;
}

export interface HarnessSelection {
  readonly harness: HarnessName;
  readonly sandbox?: SandboxMode;
}

function validateHarnessIdentifier(raw: string, prefix = ""): void {
  if (!HARNESS_IDENTIFIER.test(raw)) {
    throw new Error(
      `${prefix}invalid harness name ${JSON.stringify(raw)} (expected a lowercase identifier such as "pi-durable" or "dsh")`,
    );
  }
}

/**
 * Resolve the effective harness and sandbox posture with precedence:
 * explicit override (CLI flag / openAgent option) > environment (`FASTAGENT_HARNESS` / `FASTAGENT_SANDBOX`) >
 * `fastagent.config.ts` > defaults (`"pi-durable"`, and `"workspace"` when `"dsh"`).
 */
export function resolveHarnessSelection(
  config: Pick<AgentConfig, "harness" | "sandbox">,
  overrides: { readonly harness?: string; readonly sandbox?: string } = {},
  env?: Readonly<Record<string, string | undefined>>,
  providerCapabilities?: { readonly supportsSandbox: boolean },
): HarnessSelection {
  const envHarness = env === undefined ? decodeRuntimeCliEnv().harness : env[HARNESS_ENV];
  const envSandbox = env === undefined ? decodeRuntimeCliEnv().sandbox : env[SANDBOX_ENV];
  const rawHarness = overrides.harness ?? (envHarness || config.harness) ?? "pi-durable";
  validateHarnessIdentifier(rawHarness);
  const harness = rawHarness as HarnessName;
  const rawSandbox = overrides.sandbox ?? (envSandbox || config.sandbox);
  if (rawSandbox !== undefined && !SANDBOX_SET.has(rawSandbox)) {
    throw new Error(`unknown sandbox mode ${JSON.stringify(rawSandbox)} (allowed: ${SANDBOX_MODES.join(", ")})`);
  }
  const sandbox = rawSandbox as SandboxMode | undefined;
  if (providerCapabilities !== undefined) {
    if (!providerCapabilities.supportsSandbox) {
      if (sandbox !== undefined) {
        throw new Error(`sandbox (${JSON.stringify(sandbox)}) is not supported by harness "${harness}"`);
      }
      return { harness };
    }
    return { harness, sandbox: sandbox ?? "workspace" };
  }
  if (harness === "pi-durable") {
    if (sandbox !== undefined) {
      throw new Error(`sandbox (${JSON.stringify(sandbox)}) requires harness: "dsh"`);
    }
    return { harness };
  }
  if (harness === "dsh") {
    return { harness, sandbox: sandbox ?? "workspace" };
  }
  return sandbox === undefined ? { harness } : { harness, sandbox };
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

function checkScalarConfigFields(config: AgentConfig, file: string): void {
  const problems: string[] = [];
  if (config.model !== undefined) {
    if (typeof config.model !== "string" || config.model.length < 3) {
      problems.push("/model must be a string of at least 3 characters");
    }
  }
  if (config.thinkingLevel !== undefined) {
    if (typeof config.thinkingLevel !== "string" || !THINKING_LEVEL_SET.has(config.thinkingLevel)) {
      problems.push(`/thinkingLevel must be one of (${THINKING_LEVELS.join(", ")})`);
    }
  }
  if (config.maxSteps !== undefined) {
    if (typeof config.maxSteps !== "number" || !Number.isInteger(config.maxSteps) || config.maxSteps < 1) {
      problems.push("/maxSteps must be an integer >= 1");
    }
  }
  if (config.starters !== undefined) {
    if (!Array.isArray(config.starters)) {
      problems.push("/starters must be an array");
    } else {
      if (config.starters.length > MAX_STARTERS) {
        problems.push(`/starters must have <= ${MAX_STARTERS} items`);
      }
      for (let i = 0; i < config.starters.length; i++) {
        const item = config.starters[i];
        if (typeof item !== "string") {
          problems.push(`/starters/${i} must be a string`);
        } else if (item.length > MAX_STARTER_LENGTH || !/\S/.test(item)) {
          problems.push(`/starters/${i} must be a non-blank string of <= ${MAX_STARTER_LENGTH} characters`);
        }
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`${file}: ${problems.join("; ")}`);
  }
}

/** The program's `fastagent.config.ts` default export, checked; `{}` without one. */
export function checkProgramConfig(config: unknown, file: string): AgentConfig {
  if (config === undefined) return {};
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error(`${file} must default-export defineAgent({ ... })`);
  }
  const unknownKey = Object.keys(config).find((key) => !KEY_SET.has(key));
  if (unknownKey !== undefined) {
    const hint = unknownKey === "defaults" ? ": its keys are top-level now (model, thinkingLevel, starters)" : "";
    throw new Error(`${file}: unknown key "${unknownKey}"${hint} (keys: ${KEYS.join(", ")})`);
  }
  const typed = config as AgentConfig;
  const { model, harness, sandbox, codingTools, providers, mcpServers } = typed;
  checkScalarConfigFields(typed, file);
  if (harness !== undefined) {
    if (typeof harness !== "string") {
      throw new Error(`${file}: "harness" must be a string`);
    }
    validateHarnessIdentifier(harness, `${file}: `);
  }
  if (sandbox !== undefined && (typeof sandbox !== "string" || !SANDBOX_SET.has(sandbox))) {
    throw new Error(`${file}: unknown sandbox mode ${JSON.stringify(sandbox)} (allowed: ${SANDBOX_MODES.join(", ")})`);
  }
  if (sandbox !== undefined && (harness ?? "pi-durable") === "pi-durable") {
    throw new Error(`${file}: "sandbox" requires harness: "dsh"`);
  }
  checkCodingTools(codingTools, file);
  if (model !== undefined) modelRefOf(model, `${file}: /model`);
  if (providers !== undefined && !Array.isArray(providers)) throw new Error(`${file}: "providers" must be an array`);
  if (mcpServers !== undefined) declareServers(mcpServers, file);
  return typed;
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
