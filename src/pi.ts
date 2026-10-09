// The pi reference implementation: assembly, agent discovery, tools, config, models, auth, and state ports.
export {
  createPiAgent,
  createPiAgentFromDefinition,
  type CreatePiAgentFromDefinitionOptions,
  type CreatePiAgentOptions,
} from "./harnesses/pi/create.ts";

export {
  defineTool,
  type DefineToolOptions,
  type FastagentTool,
  type MountedTool,
  type ToolCollision,
  type ToolContext,
} from "./harnesses/pi/tool.ts";
export type { ReadonlySessionManager, ToolActivation } from "./harnesses/pi/tool-context.ts";
export { z } from "zod";
export type { AgentTool } from "@earendil-works/pi-agent-core";
export type { Skill } from "@earendil-works/pi-coding-agent";
/** A conversation record, as the tool runtime and the control plane hold it. */
export type { SessionManager, SessionEntry as PiSessionEntry } from "@earendil-works/pi-coding-agent";

export {
  availableModelsFromDir,
  createPiAgentFromDir,
  type CreatePiAgentFromDirOptions,
  refreshMachineModelCatalog,
  refreshModelCatalog,
} from "./harnesses/pi/open.ts";
export type {
  DefinitionDiagnostic,
  DefinitionFile,
  DefinitionPrompt,
  DefinitionShadow,
  LoadedDefinition,
  SkillCollision,
} from "./harnesses/pi/definition.ts";

export {
  defineConfig,
  listModels,
  resolveModel,
  type FastagentConfig,
} from "./harnesses/pi/config.ts";
// Creating an agent and editing its contexts: what `fastagent init` and `fastagent context` run.
export {
  addContext,
  ContextNameError,
  createAgent,
  listContexts,
  removeContext,
  type ContextEdit,
  type CreateAgentOptions,
  type CreatedAgent,
} from "./harnesses/pi/authoring.ts";
export type { SessionObserver } from "./harnesses/pi/turn-kit.ts";
export { inProcessLease, type Lease, type Release } from "./harnesses/pi/turn-kit.ts";
export {
  createPiSessionControl,
  type CreatePiSessionControlOptions,
} from "./harnesses/pi/session-control.ts";
export {
  piInMemorySessionRecordStore,
  piSessionRecordStore,
  type PiSessionRecordStore,
} from "./harnesses/pi/session-store.ts";
export type { SessionInheritance } from "./harnesses/pi/session-inheritance.ts";

export { GLOBAL_AUTH_PATH, fastagentCredentialStore, type FastagentAuthOptions } from "./harnesses/pi/auth.ts";
export { createPiModels, type CreatePiModelsOptions } from "./harnesses/pi/agent-models.ts";
export { probeAuthSource } from "./harnesses/pi/models.ts";
export {
  login,
  loginOptions,
  LoginCancelled,
  type LoginMethod,
  type LoginOption,
  type LoginRequest,
  type LoginResult,
} from "./harnesses/pi/login.ts";
/** pi-ai's sign-in types, and the `CredentialStore` a caller supplies as `credentialStore` (with what it holds). */
export type { AuthEvent, AuthInteraction, AuthPrompt, Credential, CredentialStore } from "@earendil-works/pi-ai";
export type { Models } from "@earendil-works/pi-ai";
// Types only: they appear in our signatures, so a caller must be able to name them.
export type { Provider, ProviderAuth } from "@earendil-works/pi-ai";
export type { Model } from "@earendil-works/pi-ai";

// The product's one-call assembly: a directory becomes a live service.
export { createAgentService, type CreateAgentServiceOptions } from "./harnesses/pi/service.ts";
