// Engine-neutral Agent Handler contract, consumption helpers, host/channel kit, and time triggers.
// Import this subpath from channel packages or contract-only integrations to avoid loading the pi runtime.
// Session-control layering (design §1): the CONTRACT (SessionControl types, error codes) lives
// behind the `/session` subpath so interactive serving does not grow the minimal handler contract,
// and the pi hub (`createPiSessionControl`) lives under `/pi`. The engine-neutral TRANSPORT —
// `controlRoutes` server-side, `connectSessionControl`/`connectAgent` client-side — belongs here
// with the rest of the channel kit: fetch-shaped routes and contract-consuming clients, no pi
// import anywhere in their closure.
export type { Agent, AgentEvent, ImageRef, Json, Prompt, Scope } from "./agent.ts";
export { collect, AgentFailure, type CollectResult } from "./collect.ts";
export type { ModuleLoadFailure } from "./loader.ts";

export { createInvokeHandler, nodeListener } from "./channels/http.ts";
export { controlRoutes, type ControlRoutesOptions, type WireEvent } from "./channels/control.ts";
export {
  ControlRequestError,
  connectAgent,
  connectSessionControl,
  type RemoteEndpointOptions,
} from "./session-remote.ts";
export { readBodyCapped } from "./channels/body.ts";
export { text, textHeaders } from "./channels/respond.ts";
export {
  type ChannelContext,
  type ChannelHandler,
  type ChannelModule,
  type Routes,
  router,
  serveNode,
} from "./host/node.ts";

export { defineSchedule, type LoadedSchedule, type Schedule } from "./schedule/schedule.ts";
export { discoverScheduleFiles, loadSchedules } from "./schedule/discover.ts";
export { createScheduler, scheduleSession, type Scheduler, type SchedulerOptions } from "./schedule/scheduler.ts";
