// The pi reference implementation: assembly, agent discovery, tools, config, models, auth, and state ports.
export {
  createPiAgent,
  createPiAgentFromDefinition,
  type CreatePiAgentFromDefinitionOptions,
  type CreatePiAgentOptions,
} from "./engines/pi/create.ts";

export {
  defineTool,
  loadTools,
  type DefineToolOptions,
  type FastagentTool,
  type MountedTool,
  type ToolCollision,
  type ToolContext,
} from "./engines/pi/tool.ts";
export type { ReadonlySessionManager, ToolActivation } from "./engines/pi/tool-context.ts";
export { z } from "zod";
export type { AgentTool, ExecutionEnv, Skill, SkillDiagnostic } from "@earendil-works/pi-agent-core";
/** A record's entries, as the tool runtime and the control plane see them (pi's v3 jsonl shape). */
export type { SessionEntry as SessionTreeEntry, SessionManager as Session } from "@earendil-works/pi-coding-agent";

export { loadChannels, type ChannelCollision } from "./engines/pi/channel.ts";
export {
  createPiAgentFromDir,
  type CreatePiAgentFromDirOptions,
} from "./engines/pi/open.ts";
export type { LoadedDefinition, SkillCollision } from "./engines/pi/definition.ts";

export { defineConfig, listModels, resolveModel, type FastagentConfig } from "./engines/pi/config.ts";
export type { SessionObserver } from "./engines/pi/turn-kit.ts";
export { inProcessLease, type Lease, type Release } from "./engines/pi/turn-kit.ts";
export {
  createPiSessionControl,
  type CreatePiSessionControlOptions,
} from "./engines/pi/session-control.ts";
export {
  piInMemorySessionRecordStore,
  piSessionRecordStore,
  type PiSessionRecordStore,
} from "./engines/pi/session-store.ts";
export type { SessionInheritance } from "./engines/pi/session-inheritance.ts";

export { GLOBAL_AUTH_PATH, fastagentCredentialStore, type FastagentAuthOptions } from "./engines/pi/auth.ts";
export { createPiModels, probeAuthSource, type CreatePiModelsOptions } from "./engines/pi/models.ts";
export type { Models } from "@earendil-works/pi-ai";
export { createProvider, type Provider, type ProviderAuth } from "@earendil-works/pi-ai";
export type { Model } from "@earendil-works/pi-ai";
