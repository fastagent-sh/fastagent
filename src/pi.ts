// The pi reference implementation: assembly, workspace discovery, tools, config, models, auth, and state ports.
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
  type ToolCollision,
  type ToolContext,
} from "./engines/pi/tool.ts";
export { z } from "zod";
export type { AgentTool, ExecutionEnv, Session, Skill, SkillDiagnostic } from "@earendil-works/pi-agent-core";

export { loadChannels, type ChannelCollision } from "./engines/pi/channel.ts";
export {
  createPiAgentFromWorkspace,
  type CreatePiAgentFromWorkspaceOptions,
} from "./engines/pi/workspace.ts";
export type { LoadedDefinition, SkillCollision } from "./engines/pi/definition.ts";

export { defineConfig, listModels, resolveModel, type FastagentConfig } from "./engines/pi/config.ts";
export { inProcessLease, type Lease, type Release } from "./engines/pi/invoke.ts";
export type { AnyModel } from "./engines/pi/harness.ts";
export { inMemorySessionStore, jsonlSessionStore, type PiSessionStore } from "./engines/pi/sessions.ts";

export { GLOBAL_AUTH_PATH, fastagentCredentialStore, type FastagentAuthOptions } from "./engines/pi/auth.ts";
export { createPiModels, probeAuthSource, type CreatePiModelsOptions } from "./engines/pi/models.ts";
export type { Models } from "@earendil-works/pi-ai";
export { createProvider, type Provider, type ProviderAuth } from "@earendil-works/pi-ai";
export type { Model } from "@earendil-works/pi-ai";
