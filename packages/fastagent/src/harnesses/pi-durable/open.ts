/**
 * `pi-durable` agent assembler: takes an already-built definition (`harnesses/assembly.ts`) and opens a
 * `DurableAgent` over `pi-durable` with its coding tools, authored tools, MCP tools, extensions, and execution env.
 */
import type { AgentInfo, ModelRef } from "@fastagent-sh/client/agent-api";
import type { Models } from "@earendil-works/pi-ai";
import {
  type Extension,
  type HarnessSettings,
  type Storage,
  type ToolRegistration,
  createRegistry,
  defineExtension,
  section,
} from "@earendil-works/pi-durable";
import {
  CodingTools,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-durable/tools";
import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import type { WorkTracker } from "../../busy.ts";
import type { AgentDefinition } from "../../definition/definition.ts";
import { instanceName } from "../../instance-name.ts";
import type { RunsAs } from "../../serving-command.ts";
import {
  type BuiltDefinition,
  DEFINITION_EXTENSION,
  type Unfinished,
  assertNoMcpToolConflicts,
  resolveDefaultModel,
} from "../assembly.ts";
import { agentPresentation, resolveCodingTools } from "../config.ts";
import { CODING_TOOL_NAMES, type CodingToolName } from "../define.ts";
import { definitionSections, readCommands } from "../text.ts";
import type { PortableTool } from "../tool.ts";
import { type DurableAgent, openDurableAgent } from "./agent.ts";
import { InstanceExecutionEnv } from "./execution-env.ts";

export interface AssembleAgentOptions {
  storage: Storage;
  runsAs: RunsAs;
  name?: string;
  workdir?: string;
  code: BuiltDefinition;
  mcpTools?: readonly PortableTool[];
  models: Models;
  model?: string;
  resolvedModel?: {
    readonly model?: ModelRef;
    readonly unusableDefault?: NonNullable<AgentInfo["unusableDefault"]>;
  };
  settings?: HarnessSettings;
  unfinished?: Unfinished;
  processEnv: Readonly<Record<string, string>>;
  telemetry?: TelemetryContext;
  maxMessageBytes?: number;
  work?: WorkTracker;
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
  const { model, unusableDefault } =
    options.resolvedModel ?? resolveDefaultModel(spec, options.model !== undefined, models);
  assertNoMcpToolConflicts(code, options.mcpTools ?? []);
  const selectedCodingTools = resolveCodingTools(config.codingTools);
  const builtinCoding = codingToolsExtension(selectedCodingTools);
  const registry = createRegistry();
  if (builtinCoding !== undefined) registry.install(builtinCoding);
  const sections = definitionSections(dir, {
    runsAs: options.runsAs,
    workdir: options.workdir ?? dir,
    source: definition.source === true,
    codingTools: selectedCodingTools,
  }).map((entry) => section(entry.key, () => entry.render(), entry.tag === undefined ? undefined : { tag: entry.tag }));
  registry.install(
    defineExtension({
      name: DEFINITION_EXTENSION,
      sections,
      tools: [...code.tools, ...(options.mcpTools ?? [])] as ToolRegistration[],
    }),
  );
  for (const raw of code.extensions) registry.install(raw as Extension);
  const { thinkingLevel, maxSteps } = config;
  return openDurableAgent({
    storage: options.storage,
    models,
    registry,
    name: options.name ?? instanceName(definition.name),
    ...agentPresentation(definition),
    ...(model === undefined ? {} : { model }),
    ...(unusableDefault === undefined ? {} : { unusableDefault }),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    ...(maxSteps === undefined ? {} : { maxSteps }),
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    ...(options.unfinished === undefined ? {} : { unfinished: options.unfinished }),
    ...(options.telemetry === undefined ? {} : { telemetry: options.telemetry }),
    ...(options.maxMessageBytes === undefined ? {} : { maxMessageBytes: options.maxMessageBytes }),
    ...(options.work === undefined ? {} : { work: options.work }),
    env: ({ cwd }) => new InstanceExecutionEnv({ cwd: cwd ?? options.workdir ?? dir, processEnv: options.processEnv }),
    commands: () => readCommands(dir),
  });
}
