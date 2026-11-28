/**
 * What an agent's author writes in `fastagent.config.ts`: `defineAgent()` returns its typed configuration object;
 * `harnesses/assembly.ts` validates and loads it at startup.
 */
import type { ModelThinkingLevel, Provider } from "@earendil-works/pi-ai";
import type { McpServerDeclaration } from "../mcp/config.ts";
import type { Needs } from "../needs.ts";

/** The built-in coding tools FastAgent ships. */
export const CODING_TOOL_NAMES = ["read", "write", "edit", "bash"] as const;
export type CodingToolName = (typeof CODING_TOOL_NAMES)[number];
/** Built-in coding tools to install: `true` (default) for all four, `false` for none, or an explicit subset. */
export type CodingToolsConfig = boolean | readonly CodingToolName[];

/** First-party runtime harnesses; third-party `@fastagent-sh/harness-<name>` plugins are also accepted. */
export type HarnessName = "pi-durable" | "dsh" | (string & {});

/** OS sandbox posture (applicable on sandbox-capable harnesses such as `"dsh"`). */
export const SANDBOX_MODES = ["workspace", "read-only", "off"] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];

/** What `fastagent.config.ts` default-exports: the agent's own settings, the same for every place it runs. */
export interface AgentConfig {
  /** `"provider/modelId"`: what a session that names none answers with; `--model` or `FASTAGENT_MODEL` may override it. */
  model?: string;
  thinkingLevel?: ModelThinkingLevel;
  /** Runtime harness. Default `"pi-durable"`; pass `"dsh"` or another `@fastagent-sh/harness-<name>` plugin name. */
  harness?: HarnessName;
  /** OS sandbox mode on sandbox-capable harnesses (`"workspace"` default, `"read-only"`, or `"off"`). */
  sandbox?: SandboxMode;
  /** Built-in coding tools (`read`, `write`, `edit`, `bash`). Default `true`; pass `false` or a subset to restrict. */
  codingTools?: CodingToolsConfig;
  /** Maximum model steps (tool rounds) per message turn before stopping `incomplete`. Positive integer; unset means unlimited. */
  maxSteps?: number;
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
