/**
 * The Agent API over HTTP, for a program anywhere `fetch` runs (agent-api.md §8): `connectAgent`, its errors and the
 * types. It opens no agent and needs no Node API, so it also runs on Deno and Workers.
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

export { connectAgent, type ConnectOptions } from "./http/client.ts";
