// Engine-neutral Agent Handler contract, consumption helpers, host/channel kit, and time triggers.
// Import this subpath from channel packages or contract-only integrations to avoid loading the pi runtime.
export type { Agent, AgentEvent, ImageRef, Json, Prompt, Scope } from "./agent.ts";
export { collect, AgentFailure, type CollectResult } from "./collect.ts";
export type { ModuleLoadFailure } from "./loader.ts";

export { createInvokeHandler, nodeListener } from "./channels/http.ts";
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
