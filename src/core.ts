// Harness-neutral: the Agent API (docs/design/agent-api.md) and the channel contract a channel is written against.
// No Node built-in, no harness.
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
  ModelRef,
  Page,
  SendRequest,
  Session,
  SessionChanges,
  SessionEvent,
  SessionSettings,
  ThinkingLevel,
  Tokens,
  Usage,
  WaitOptions,
} from "./agent-api.ts";
export { AgentError, LIMITS, hasEnded } from "./agent-api.ts";
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
export type { Schedule, ScheduleConfig } from "./schedule/schedule.ts";
export type { DeclaredSecret } from "./declared-secrets.ts";
