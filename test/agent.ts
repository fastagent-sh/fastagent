/**
 * One faux-backed SPEC v1 agent, assembled the way serving assembles one (`agentOf`): pi through `LoopPort`, behind
 * the serving layer. Tests that care about tools, skills, settings or a channel should not each re-derive the wiring.
 */
import { dirname } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { ModelRuntime, type Skill } from "@earendil-works/pi-coding-agent";
import { piLoopHarness } from "../src/harnesses/pi/loop-harness.ts";
import type { PiSessionDefinition } from "../src/harnesses/pi/session-binding.ts";
import { type PiSessionRecordStore, piInMemorySessionRecordStore } from "../src/harnesses/pi/session-store.ts";
import type { MountedTool } from "../src/harnesses/pi/tool.ts";
import { loopPort } from "../src/loop-port.ts";
import type { Agent, AgentCommand } from "../src/protocol.ts";
import { servingAgent } from "../src/serving-layer.ts";
import { makeFaux } from "./faux.ts";

/** A definition skill as the loader hands it to a session: pi reads its body from `filePath` when it is used. */
export function definitionSkill(
  fields: Pick<Skill, "name" | "description" | "filePath"> & { disableModelInvocation?: boolean },
): Skill {
  const baseDir = dirname(fields.filePath);
  return {
    disableModelInvocation: false,
    ...fields,
    baseDir,
    sourceInfo: { path: fields.filePath, source: "fastagent", scope: "project", origin: "top-level", baseDir },
  };
}

export interface FauxAgentOptions {
  /** Defaults to a fresh in-memory store; pass one to share continuity across agents. */
  sessions?: PiSessionRecordStore;
  tools?: MountedTool[];
  systemPrompt?: string;
  /** The whole definition a binding reads; `systemPrompt` is its shorthand. */
  readDefinition?: () => PiSessionDefinition | Promise<PiSessionDefinition>;
  cwd?: string;
  /** Faux model shape (e.g. a reasoning model, to exercise thinking levels). */
  faux?: Parameters<typeof makeFaux>[0];
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
  /** The definition's own `extensions/` files, loaded into every bound session. */
  extensionPaths?: string[];
  /** Wire no default model, as an agent whose config sets none: a session runs on the model it records, or not at all. */
  noDefaultModel?: boolean;
  commands?: () => Promise<AgentCommand[]>;
}

export function fauxAgent(
  responses: FauxResponseStep[],
  options: FauxAgentOptions = {},
): {
  agent: Agent;
  faux: ReturnType<typeof makeFaux>["faux"];
  sessions: PiSessionRecordStore;
  /** The registry sessions resolve against: the faux provider, and nothing from the network. */
  models: () => Promise<ModelRuntime>;
} {
  const { faux } = makeFaux(options.faux);
  faux.setResponses(responses);
  const model = options.modelId ? faux.getModel(options.modelId) : faux.getModel();
  if (!model) throw new Error(`faux model ${options.modelId} is not registered`);
  const cwd = options.cwd ?? process.cwd();
  const sessions = options.sessions ?? piInMemorySessionRecordStore({ cwd });
  const createModelRuntime = async () => {
    const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
    runtime.registerNativeProvider(faux.provider);
    return runtime;
  };
  let catalog: Promise<ModelRuntime> | undefined;
  const models = () => (catalog ??= createModelRuntime());
  const harness = piLoopHarness({
    sessions,
    createModelRuntime,
    catalog: models,
    ...(options.noDefaultModel ? {} : { modelSpec: `${model.provider}/${model.id}` }),
    ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
    ...(options.tools ? { tools: options.tools } : {}),
    ...(options.extensionPaths ? { extensionPaths: async () => options.extensionPaths ?? [] } : {}),
    ...(options.commands ? { commands: options.commands } : {}),
    readDefinition: options.readDefinition ?? (() => ({ systemPrompt: options.systemPrompt ?? "test", skills: [] })),
    cwd,
  });
  return { agent: servingAgent(loopPort(harness)), faux, sessions, models };
}
