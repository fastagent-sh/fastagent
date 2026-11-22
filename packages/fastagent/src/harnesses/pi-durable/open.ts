/**
 * `pi-durable` agent assembler: takes an already-built definition (`harnesses/assembly.ts`) and opens a
 * `DurableAgent` over `pi-durable` with its coding tools, authored tools, MCP tools, extensions, and execution env.
 */
import type { Models } from "@earendil-works/pi-ai";
import {
  type Extension,
  type HarnessSettings,
  type Storage,
  type ToolRegistration,
  createRegistry,
  defineExtension,
} from "@earendil-works/pi-durable";
import {
  CodingTools,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-durable/tools";
import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import type { AgentInfo, ModelRef } from "@fastagent-sh/client/agent-api";
import type { AgentDefinition } from "../../definition/definition.ts";
import { instanceName } from "../../instance-name.ts";
import { log } from "../../log.ts";
import { modelRefOf } from "../../model-ref.ts";
import type { RunsAs } from "../../serving-command.ts";
import { type BuiltDefinition, DEFINITION_EXTENSION, type Unfinished } from "../assembly.ts";
import { agentPresentation, resolveCodingTools } from "../config.ts";
import { CODING_TOOL_NAMES, type CodingToolName } from "../define.ts";
import { definitionSections, readCommands } from "../text.ts";
import { type DurableAgent, openDurableAgent } from "./agent.ts";
import { InstanceExecutionEnv } from "./execution-env.ts";

export interface AssembleAgentOptions {
  storage: Storage;
  runsAs: RunsAs;
  name?: string;
  workdir?: string;
  code: BuiltDefinition;
  mcpTools?: ToolRegistration[];
  models: Models;
  model?: string;
  settings?: HarnessSettings;
  unfinished?: Unfinished;
  processEnv: Readonly<Record<string, string>>;
  telemetry?: TelemetryContext;
  maxMessageBytes?: number;
}

function resolveDefaultModel(
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

const CODING_TOOL_FACTORIES: Record<CodingToolName, () => ToolRegistration> = {
  read: () => createReadTool(),
  write: () => createWriteTool(),
  edit: () => createEditTool(),
  bash: () => createBashTool(),
};

function codingToolsExtension(selected: readonly CodingToolName[]): Extension | undefined {
  if (selected.length === 0) return undefined;
  const unique = new Set(selected);
  if (CODING_TOOL_NAMES.every((name) => unique.has(name))) return CodingTools;
  return defineExtension({
    name: CodingTools.name,
    tools: [...unique].map((name) => CODING_TOOL_FACTORIES[name]()),
  });
}

/** Open the definition as a `pi-durable` Agent over `models`: selected coding tools, then authored and MCP tools. */
export async function assembleAgent(definition: AgentDefinition, options: AssembleAgentOptions): Promise<DurableAgent> {
  const { dir, config } = definition;
  const { code, models } = options;
  const spec = options.model ?? config.model;
  const { model, unusableDefault } = resolveDefaultModel(spec, options.model !== undefined, models);
  const authoredNames = new Set(
    [...code.tools, ...code.extensions.flatMap((extension) => extension.tools ?? [])].map((tool) => tool.name),
  );
  for (const tool of options.mcpTools ?? []) {
    if (authoredNames.has(tool.name)) throw new Error(`MCP tool ${tool.name} conflicts with an authored tool`);
  }
  const selectedCodingTools = resolveCodingTools(config.codingTools);
  const builtinCoding = codingToolsExtension(selectedCodingTools);
  const registry = createRegistry();
  if (builtinCoding !== undefined) registry.install(builtinCoding);
  registry.install(
    defineExtension({
      name: DEFINITION_EXTENSION,
      sections: definitionSections(dir, {
        runsAs: options.runsAs,
        workdir: options.workdir ?? dir,
        source: definition.source === true,
        codingTools: selectedCodingTools,
      }),
      tools: [...code.tools, ...(options.mcpTools ?? [])],
    }),
  );
  for (const extension of code.extensions) registry.install(extension);
  const { thinkingLevel } = config;
  return openDurableAgent({
    storage: options.storage,
    models,
    registry,
    name: options.name ?? instanceName(definition.name),
    ...agentPresentation(definition),
    ...(model === undefined ? {} : { model }),
    ...(unusableDefault === undefined ? {} : { unusableDefault }),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    ...(options.unfinished === undefined ? {} : { unfinished: options.unfinished }),
    ...(options.telemetry === undefined ? {} : { telemetry: options.telemetry }),
    ...(options.maxMessageBytes === undefined ? {} : { maxMessageBytes: options.maxMessageBytes }),
    env: ({ cwd }) => new InstanceExecutionEnv({ cwd: cwd ?? options.workdir ?? dir, processEnv: options.processEnv }),
    commands: () => readCommands(dir),
  });
}
