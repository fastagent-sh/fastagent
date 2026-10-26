// The agent on pi-durable: what an author writes, opening a definition as an Agent, and the model environment it
// answers with.
export {
  defineAgent,
  defineSchedule,
  needs,
  type AgentConfig,
  type Needs,
  type SecretSpec,
  type SecretValues,
} from "./harnesses/pi-durable/define.ts";
export {
  buildDefinition,
  loadDefinition,
  openAgent,
  prepareDefinition,
  secretsManifest,
  type AgentDefinition,
  type BuiltDefinition,
  type OpenAgentOptions,
} from "./harnesses/pi-durable/open.ts";
export { type OpenedServing, type OpenServingOptions, openServing } from "./harnesses/pi-durable/serve.ts";
export type { DurableAgent } from "./harnesses/pi-durable/agent.ts";
// A tool's own session id, as the Agent hands it out: what a channel's thread-reading tool asks with.
export { sessionIdOf } from "./harnesses/pi-durable/ids.ts";

export { GLOBAL_AUTH_PATH, fastagentCredentialStore, type FastagentAuthOptions } from "./harnesses/models/credentials.ts";
export {
  createPiModels,
  modelEnvironment,
  type CreatePiModelsOptions,
  type ModelEnvironment,
} from "./harnesses/models/environment.ts";
export { probeAuthSource } from "./harnesses/models/models.ts";
export {
  login,
  loginOptions,
  LoginCancelled,
  type LoginMethod,
  type LoginOption,
  type LoginRequest,
  type LoginResult,
} from "./harnesses/models/login.ts";
/** pi-ai's sign-in types, and the `CredentialStore` a caller supplies as `credentialStore` (with what it holds). */
export type { AuthEvent, AuthInteraction, AuthPrompt, Credential, CredentialStore } from "@earendil-works/pi-ai";
export type { Models } from "@earendil-works/pi-ai";
// Types only: they appear in our signatures, so a caller must be able to name them.
export type { Provider, ProviderAuth } from "@earendil-works/pi-ai";
export type { Model } from "@earendil-works/pi-ai";
