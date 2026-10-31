/**
 * The package's one entry (SPEC.md §8), besides each first-party channel's: the Agent API, opening an agent
 * directory and serving it, what a host embedding agents needs beside them (creating one, model credentials and
 * sign-in), and what an author writes.
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
export {
  ContentNameError,
  addContent,
  createAgent,
  listContent,
  removeContent,
  type ContentEdit,
  type CreatedAgent,
} from "./authoring.ts";
export type { ContentAddition, SourceOptions } from "./content/source.ts";
export { readContentSource } from "./content/source.ts";
export type { BoundContent, ContentBinding, ContentEntry } from "./content/declare.ts";
export type { ResolvedContent } from "./content/resolve.ts";
export {
  SignInCancelled,
  type Credential,
  type CredentialStore,
  type ProviderAuth,
  type SignInEvent,
  type SignInInteraction,
  type SignInMethod,
  type SignInOption,
  type SignInPrompt,
  type SignInRequest,
  type SignInResult,
} from "./sign-in-api.ts";
export { credentialFile, providerAuth, signIn, signInOptions } from "./harnesses/models/host.ts";

export {
  defineAgent,
  defineSchedule,
  needs,
  type AgentConfig,
  type Needs,
  type SecretSpec,
  type SecretValues,
} from "./harnesses/pi-durable/define.ts";
export type { ScheduleConfig } from "./schedule/schedule.ts";
export {
  defineChannel,
  type ChannelContext,
  type ChannelHandler,
  type ChannelModule,
  type ForkSource,
  type LongConnection,
  type LongConnectionChannelModule,
  type Routes,
} from "./channel.ts";
// What a channel reads a request with, answers with, and compares its platform's secret with (constant time).
export { readBodyCapped } from "./channels/body.ts";
export { text } from "./channels/respond.ts";
export { secretEquals } from "./channels/secret.ts";
// The session a tool runs in, as the Agent hands it out: what a channel's thread-reading tool asks with.
export { sessionIdOf } from "./harnesses/pi-durable/ids.ts";
