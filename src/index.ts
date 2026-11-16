/**
 * The package's one entry, besides each first-party channel's: the Agent API, opening an agent
 * directory and serving it, and what an author writes.
 */
export type {
  Agent,
  AgentErrorData,
  AgentInfo,
  CompactOptions,
  ContentPart,
  CreateSessionOptions,
  EntriesOptions,
  Entry,
  ErrorCode,
  Json,
  ListOptions,
  Message,
  MessageKey,
  MessageStatus,
  MessageStreamEvent,
  Metadata,
  ModelRef,
  Page,
  SendRequest,
  Session,
  SessionChanges,
  SessionEvent,
  SessionSettings,
  SessionStatus,
  ThinkingLevel,
  Tokens,
  Usage,
  WaitOptions,
} from "./agent-api.ts";
export { AgentError, LIMITS, hasEnded } from "./agent-api.ts";

export {
  openAgent,
  type LocalAgent,
  type OpenAgentOptions,
  type ServeAgentOptions,
} from "./harnesses/pi-durable/serve.ts";
export type { Service } from "./service.ts";
export { McpError, type McpErrorCode } from "./mcp-api.ts";
export { baseEnv } from "./child-env.ts";

export { defineAgent, defineSchedule, type AgentConfig } from "./harnesses/pi-durable/define.ts";
export { needs, type Needs, type SecretSpec, type SecretValues } from "./needs.ts";
export type { ScheduleConfig } from "./schedule/schedule.ts";
// What `fastagent build` writes into a package's generated entry, never written by hand.
export { defineDefinition, type AgentDefinition } from "./harnesses/pi-durable/definition.ts";
export {
  defineChannel,
  type Channel,
  type ChannelContext,
  type ChannelHandler,
  type ChannelTool,
  type ConnectionChannel,
  type ForkSource,
  type LongConnection,
  type RouteChannel,
  type Routes,
} from "./channel.ts";
// What a channel reads a request with, answers with, and compares its platform's secret with (constant time).
export { readBodyCapped } from "./channels/kit/body.ts";
export { text } from "./channels/kit/respond.ts";
export { secretEquals } from "./channels/kit/secret.ts";
// The session a tool runs in, as the Agent hands it out.
export { sessionIdOf } from "./harnesses/pi-durable/ids.ts";
