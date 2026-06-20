/**
 * Workspace resolution: the shared M-side of opening a workspace folder into an agent.
 *
 * Both the dev opener (dev.ts, authoring posture) and the embed opener (embed.ts, production-embed
 * posture) need the SAME "point at a folder, read its config" work: resolve the model (flag > env >
 * config), discover and merge tools (pi defaults + config.tools + `tools/`), and report what was
 * assembled. They differ ONLY on the K axis (sessions/env/lease/auth) and side effects — which is
 * exactly what stays OUT of here.
 *
 * resolveWorkspace is pure M + read-only IO: it loads config and imports tool modules, but it does
 * NOT touch the K axis and does NOT create directories or write anything. The caller owns K and any
 * side effects (dev creates `.fastagent/`; embed creates nothing).
 */
import { type FastagentConfig, loadConfig, resolveModel, resolveModelSpec } from "./config.ts";
import { piDefaultTools, resolveTools } from "./create.ts";
import type { AnyModel } from "./harness.ts";
import { type ToolCollision, loadTools, mergeDiscoveredTools } from "./tool.ts";
import type { AgentTool } from "@earendil-works/pi-agent-core";

export interface ResolveWorkspaceOptions {
  /** Model spec override (e.g. a CLI --model flag). Precedence: this > FASTAGENT_MODEL > config.model. */
  model?: string;
}

export interface ResolvedWorkspace {
  config: FastagentConfig;
  /** Config file path; undefined when running zero-config. */
  configPath?: string;
  /** The resolved "provider/modelId" spec actually in use. */
  modelSpec: string;
  /** The model object (M), ready for the assembly ladder. */
  model: AnyModel;
  /** pi defaults + config.tools + discovered `tools/`, name clashes resolved (existing win). */
  tools: AgentTool[];
  /** Non-default tool names in effect: config.tools + discovered tools/. */
  toolNames: string[];
  /** Discovered tools dropped on a name clash with a default/config tool (surfaced, not silent). */
  toolCollisions: ToolCollision[];
}

/**
 * Resolve a workspace folder to its model + tools (and the config behind them). No K, no side
 * effects. Throws a clear error when no model source is set (fail visibly at startup).
 */
export async function resolveWorkspace(dir: string, options: ResolveWorkspaceOptions = {}): Promise<ResolvedWorkspace> {
  const { config, path: configPath } = await loadConfig(dir);
  const modelSpec = resolveModelSpec(options.model, config);
  if (!modelSpec) {
    throw new Error(
      `missing model: set --model, "model" in fastagent.config.ts, or FASTAGENT_MODEL (e.g. "openai-codex/gpt-5.5")`,
    );
  }
  const discovered = await loadTools(dir);
  const { tools, collisions: crossCollisions } = mergeDiscoveredTools(resolveTools(config, dir), discovered.tools);
  const toolCollisions = [...discovered.collisions, ...crossCollisions];
  const defaultNames = new Set(piDefaultTools(dir).map((t) => t.name));
  const toolNames = tools.map((t) => t.name).filter((n) => !defaultNames.has(n));
  return { config, configPath, modelSpec, model: resolveModel(modelSpec), tools, toolNames, toolCollisions };
}
