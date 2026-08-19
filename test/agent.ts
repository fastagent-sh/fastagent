/**
 * One faux-backed agent, assembled the way serving assembles one. Tests that care about a channel,
 * the control plane or the HTTP surface should not each re-derive the engine wiring.
 */
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Agent } from "../src/agent.ts";
import { piAgentSessionFactory } from "../src/engines/pi/agent-session-factory.ts";
import { createPiAgentFromSession } from "../src/engines/pi/invoke-session.ts";
import { type PiSessionRecordStore, piInMemorySessionRecordStore } from "../src/engines/pi/session-store.ts";
import type { MountedTool } from "../src/engines/pi/tool.ts";
import { type Lease, type SessionObserver, inProcessLease } from "../src/engines/pi/turn-kit.ts";
import { type CreatePiSessionControlOptions, createPiSessionControl } from "../src/engines/pi/session-control.ts";
import type { SessionControl } from "../src/session.ts";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { makeFaux } from "./faux.ts";

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
      engine: async () => {
        const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
        modelRuntime.registerNativeProvider(faux.provider);
        return { modelRuntime, model: faux.getModel() };
      },
      ...(options.tools ? { tools: options.tools } : {}),
      systemPrompt: options.systemPrompt ?? "test",
      cwd,
      env: new NodeExecutionEnv({ cwd }),
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
    engine: async () => ({ modelRuntime, model }),
    ...(options.tools ? { tools: options.tools } : {}),
    ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
    systemPrompt: options.systemPrompt ?? "test",
    cwd,
    env: new NodeExecutionEnv({ cwd }),
  });
  const { control, observer } = createPiSessionControl({
    sessions,
    boundary:
      options.boundary === false
        ? undefined
        : () => ({
            lease,
            models: modelRuntime,
            sessionFactory,
            defaults: { model, thinkingLevel: options.thinkingLevel ?? "medium" },
          }),
    ...(options.commands ? { commands: options.commands } : {}),
    ...(options.tap ? { tap: options.tap } : {}),
  });
  const agent = createPiAgentFromSession({ lease, observer, sessionFactory });
  return { agent, control, observer, sessions, faux, lease, models: modelRuntime };
}
