// Engine-neutral Agent Handler contract, consumption helpers, channel kit, and time triggers.
export type { Agent, AgentEvent, ImageRef, Json, Prompt, Scope } from "./agent.ts";
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
export { defineSchedule, type LoadedSchedule, type Schedule } from "./schedule/schedule.ts";
