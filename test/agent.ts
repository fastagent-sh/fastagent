/**
 * One faux-backed agent, assembled the way serving assembles one. Tests that care about a channel,
 * the control plane or the HTTP surface should not each re-derive the harness wiring.
 */
import { dirname } from "node:path";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { ModelRuntime, type Skill } from "@earendil-works/pi-coding-agent";
import type { Agent } from "../src/agent.ts";
import { piAgentSessionFactory } from "../src/harnesses/pi/agent-session-factory.ts";
import { createPiAgentFromSession } from "../src/harnesses/pi/invoke-session.ts";
import { type PiSessionRecordStore, piInMemorySessionRecordStore } from "../src/harnesses/pi/session-store.ts";
import type { MountedTool } from "../src/harnesses/pi/tool.ts";
import { type Lease, type SessionObserver, inProcessLease } from "../src/harnesses/pi/turn-kit.ts";
import { type CreatePiSessionControlOptions, createPiSessionControl } from "../src/harnesses/pi/session-control.ts";
import type { SessionControl } from "../src/session.ts";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
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
  lease?: Lease;
  observer?: SessionObserver;
  tools?: MountedTool[];
  systemPrompt?: string;
  cwd?: string;
}

/**
 * Synchronous by design: assembling an agent must not await, and the faux provider reaches pi's
 * registry through the same native seam a custom provider does.
 */
export function fauxAgent(
  responses: FauxResponseStep[],
  options: FauxAgentOptions = {},
): { agent: Agent; faux: ReturnType<typeof makeFaux>["faux"]; sessions: PiSessionRecordStore } {
  const { faux } = makeFaux();
  faux.setResponses(responses);
  const cwd = options.cwd ?? process.cwd();
  const sessions = options.sessions ?? piInMemorySessionRecordStore({ cwd });
  const agent = createPiAgentFromSession({
    ...(options.lease ? { lease: options.lease } : {}),
    ...(options.observer ? { observer: options.observer } : {}),
    sessionFactory: piAgentSessionFactory({
      sessions,
      createModelRuntime: async () => {
        const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
        modelRuntime.registerNativeProvider(faux.provider);
        return modelRuntime;
      },
      modelSpec: `${faux.getModel().provider}/${faux.getModel().id}`,
      ...(options.tools ? { tools: options.tools } : {}),
      readDefinition: () => ({ systemPrompt: options.systemPrompt ?? "test", skills: [] }),
      cwd,
    }),
  });
  return { agent, faux, sessions };
}

export interface FauxControlledAgentOptions extends FauxAgentOptions {
  /** Faux model shape (e.g. a reasoning model, to exercise thinking levels). */
  faux?: Parameters<typeof makeFaux>[0];
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
  commands?: CreatePiSessionControlOptions["commands"];
  tap?: CreatePiSessionControlOptions["tap"];
  /** Wire the boundary (compact / set_model / set_thinking / navigate). Off to exercise a hub that
   *  serves observation only — where those commands are gated, not rejected per session. */
  boundary?: boolean;
  /** The definition's own `extensions/` files, loaded into every bound session. */
  extensionPaths?: string[];
  /** Wire no default model, as an agent whose config sets none: a session runs on the model it records, or not at all. */
  noDefaultModel?: boolean;
}

/**
 * The wiring `createPiSessionControl`'s doc prescribes: agent + control over ONE store, sharing the
 * lease and the session factory so boundary mutations contend with runs for real.
 *
 * Async because the registry a boundary validates against is built from credentials, and the hub's
 * surface is synchronous — the opener resolves it once for the same reason.
 */
export async function fauxControlledAgent(
  responses: FauxResponseStep[],
  options: FauxControlledAgentOptions = {},
): Promise<{
  agent: Agent;
  control: SessionControl;
  observer: SessionObserver;
  sessions: PiSessionRecordStore;
  faux: ReturnType<typeof makeFaux>["faux"];
  lease: Lease;
  models: ModelRuntime;
}> {
  const { faux } = makeFaux(options.faux);
  faux.setResponses(responses);
  const cwd = options.cwd ?? process.cwd();
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const model = options.modelId ? faux.getModel(options.modelId) : faux.getModel();
  if (!model) throw new Error(`faux model ${options.modelId} is not registered`);
  const sessions = options.sessions ?? piInMemorySessionRecordStore({ cwd });
  const lease = options.lease ?? inProcessLease();
  const sessionFactory = piAgentSessionFactory({
    sessions,
    createModelRuntime: async () => {
      const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
      runtime.registerNativeProvider(modelRuntime.getProvider(faux.provider.id) ?? faux.provider);
      return runtime;
    },
    ...(options.noDefaultModel ? {} : { modelSpec: `${model.provider}/${model.id}` }),
    ...(options.tools ? { tools: options.tools } : {}),
    ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
    ...(options.extensionPaths ? { extensionPaths: async () => options.extensionPaths ?? [] } : {}),
    readDefinition: () => ({ systemPrompt: options.systemPrompt ?? "test", skills: [] }),
    cwd,
  });
  const { control, observer } = createPiSessionControl({
    sessions,
    boundary:
      options.boundary === false
        ? undefined
        : {
            lease,
            sessionFactory,
            models: async () => modelRuntime,
            defaultModel: () => (options.noDefaultModel ? undefined : model),
            thinkingLevel: options.thinkingLevel ?? "medium",
          },
    ...(options.commands ? { commands: options.commands } : {}),
    ...(options.tap ? { tap: options.tap } : {}),
  });
  const agent = createPiAgentFromSession({
    lease,
    sessionFactory,
    observer: options.observer
      ? (session, event, run) => {
          observer(session, event, run);
          options.observer!(session, event, run);
        }
      : observer,
  });
  return { agent, control, observer, sessions, faux, lease, models: modelRuntime };
}
