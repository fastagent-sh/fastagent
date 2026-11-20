/**
 * What an agent's author writes: `defineAgent()` in `fastagent.config.ts`, `needs()` around the
 * code that reads a secret, and `defineSchedule()` in `src/schedules/`. Each returns what it was given, typed; the
 * assembly (open.ts) reads them back.
 */
import type { ModelThinkingLevel, Provider } from "@earendil-works/pi-ai";
import type { McpServerDeclaration } from "../../mcp/config.ts";
import type { Needs } from "../../needs.ts";
import type { ScheduleConfig } from "../../schedule/schedule.ts";

/** The built-in coding tools pi-durable ships. */
export const CODING_TOOL_NAMES = ["read", "write", "edit", "bash"] as const;
export type CodingToolName = (typeof CODING_TOOL_NAMES)[number];
/** Built-in coding tools to install: `true` (default) for all four, `false` for none, or an explicit subset. */
export type CodingToolsConfig = boolean | readonly CodingToolName[];

/** What `fastagent.config.ts` default-exports: the agent's own settings, the same for every place it runs. */
export interface AgentConfig {
  /** `"provider/modelId"`: what a session that names none answers with; `--model` or `FASTAGENT_MODEL` may override it. */
  model?: string;
  thinkingLevel?: ModelThinkingLevel;
  /** Built-in coding tools (`read`, `write`, `edit`, `bash`). Default `true`; pass `false` or a subset to restrict. */
  codingTools?: CodingToolsConfig;
  /** Built-in self-scheduling tools (`wake`, `unwake`). Default `false`; pass `true` to enable. */
  wakeTools?: boolean;
  /** Example first messages a client may offer as drafts, up to six: `info().starters`. */
  starters?: readonly string[];
  /** Model providers beyond pi-ai's built-ins (a self-hosted endpoint, a gateway); a built-in's id replaces it. */
  providers?: readonly (Provider | Needs<Provider>)[];
  mcpServers?: Record<string, McpServerDeclaration>;
}

/** @public */
export function defineAgent(config: AgentConfig): AgentConfig {
  return config;
}

/** What `src/schedules/<name>.ts` default-exports. */
export interface DefinedSchedule extends ScheduleConfig {
  readonly kind: "fastagent.schedule";
}

/** @public */
export function defineSchedule(config: ScheduleConfig): DefinedSchedule {
  return { kind: "fastagent.schedule", ...config };
}
