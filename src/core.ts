// Engine-neutral Agent Handler contract, consumption helpers, channel kit, and time triggers.
export type { Agent, AgentEvent, ImageRef, Json, Prompt, Scope } from "./agent.ts";
// VALUES, not types: each caller does something DIFFERENT with these two codes (retry with backoff, skip the
// occurrence, steer the live run instead of failing), which is why they are named at all. Without an export an
// embedder copies the literal, and the copy is how the first-event rule goes silently wrong.
export { ABORTED_CODE, SESSION_BUSY_CODE } from "./agent.ts";
export { collect, AgentFailure, type CollectResult } from "./collect.ts";
export type { ModuleLoadFailure } from "./loader.ts";

export { createInvokeHandler } from "./channels/http.ts";
// The control plane MOUNTS itself: `createAgentService` wires it when the config asks for it.
export type { WireEvent } from "./channels/control.ts";
export {
  ControlRequestError,
  connectAgent,
  connectSessionControl,
  type RemoteEndpointOptions,
} from "./session-remote.ts";
export { readBodyCapped } from "./channels/body.ts";
export { text, textHeaders } from "./channels/respond.ts";
export type {
  ChannelContext,
  ChannelHandler,
  ChannelModule,
  LongConnection,
  LongConnectionChannelModule,
  Routes,
} from "./channel.ts";
// Mounting only.
export { defineRoutine, type DefineRoutineOptions, type LoadedRoutine, type Routine } from "./schedule/routine.ts";
// What a `channels/*.ts` file is written against when it needs credentials: declaring them is what
// lets `deploy` carry them and the serve refuse to start without them.
export { defineChannel, type DefineChannelOptions } from "./channels/define-channel.ts";
// The one shape "which env vars does this agent need" travels in, from every authoring surface.
export type { DeclaredSecret } from "./declared-secrets.ts";
