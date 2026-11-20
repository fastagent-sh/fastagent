/** The program's `fastagent.config.ts`, checked: the one place an agent's settings are written. */
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { type Schema, arr, compile, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { declareServers } from "../../mcp/config.ts";
import { modelRefOf } from "../../model-ref.ts";
import { CODING_TOOL_NAMES, type AgentConfig, type CodingToolName, type CodingToolsConfig } from "./define.ts";
import type { AgentDefinition } from "./definition.ts";

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

const KEYS = ["model", "thinkingLevel", "codingTools", "starters", "providers", "mcpServers"];
const CODING_TOOL_SET = new Set<string>(CODING_TOOL_NAMES);

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
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !CODING_TOOL_SET.has(item)) {
      throw new Error(
        `${file}: unknown coding tool ${JSON.stringify(item)} (allowed: ${CODING_TOOL_NAMES.join(", ")})`,
      );
    }
    if (seen.has(item)) {
      throw new Error(`${file}: duplicate coding tool "${item}"`);
    }
    seen.add(item);
  }
}

/** The keys whose values are plain data; `providers` and `mcpServers` are checked by their own readers. */
const DATA: Schema = obj({
  model: opt(str({ description: 'The default model, "provider/modelId"', minLength: 3 })),
  thinkingLevel: opt(oneOf(THINKING_LEVELS)),
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
  for (const key of Object.keys(config)) {
    if (KEYS.includes(key)) continue;
    const hint =
      key === "defaults"
        ? ": its keys are top-level now (model, thinkingLevel, starters)"
        : key === "extensions"
          ? ": an extension is a module of src/extensions/ that default-exports it, whether written there or imported from a package"
          : "";
    throw new Error(`${file}: unknown key "${key}"${hint} (keys: ${KEYS.join(", ")})`);
  }
  const { model, thinkingLevel, codingTools, starters, providers, mcpServers } = config as AgentConfig;
  const validator = compile(DATA);
  const data = { model, thinkingLevel, starters };
  if (!validator.check(data)) {
    const problems = validator
      .errors(data)
      .map(({ path, message }) => `${path === "" ? "(the value)" : path} ${message}`);
    throw new Error(`${file}: ${problems.join("; ")}`);
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
