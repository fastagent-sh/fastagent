// Harness-neutral: the Agent Handler protocol (SPEC v1), consuming and serving it, the channel kit, and time triggers.
export type {
  AbortResult,
  Agent,
  AgentCommand,
  AgentError,
  AgentInfo,
  Attachment,
  Capabilities,
  Entry,
  ErrorCode,
  FollowEvent,
  ForkSource,
  InvokeEvent,
  InvokeRequest,
  Json,
  LiveEvent,
  ModelDescriptor,
  Prompt,
  ReadResult,
  Result,
  RunKey,
  RunOutcome,
  RunSource,
  RunStatus,
  Session,
  SessionEvent,
  SessionSettings,
  SessionState,
  SessionSummary,
  Usage,
  WhenBusy,
} from "./protocol.ts";
export { AgentRejection, LIMITS } from "./protocol.ts";
export { collect, type CollectedRun, RunNotCompleted, RunUnfinished } from "./protocol-collect.ts";
export type { ModuleLoadFailure } from "./loader.ts";

// The agent's API over HTTP: serve it inside an app, and call one that is served.
export { createAgentHandler } from "./channels/protocol-http.ts";
export { connectAgent, type RemoteAgentOptions } from "./protocol-remote.ts";
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
// What a `schedules/<name>.md` loads into (`AgentService.schedules`).
export type { Schedule } from "./schedule/schedule.ts";
// What a `channels/*.ts` file is written against when it needs credentials: declaring them is what
// lets `deploy` carry them and the serve refuse to start without them.
export { defineChannel, type DefineChannelOptions } from "./channels/define-channel.ts";
// The one shape "which env vars does this agent need" travels in, from every authoring surface.
export type { DeclaredSecret } from "./declared-secrets.ts";
