// The pi reference implementation: assembly, agent discovery, tools, config, models, auth, and state ports.
export {
  createPiAgent,
  createPiAgentFromDefinition,
  type CreatePiAgentFromDefinitionOptions,
  type CreatePiAgentOptions,
} from "./engines/pi/create.ts";

export {
  defineTool,
  type DefineToolOptions,
  type FastagentTool,
  type MountedTool,
  type ToolCollision,
  type ToolContext,
} from "./engines/pi/tool.ts";
export type { ReadonlySessionManager, ToolActivation } from "./engines/pi/tool-context.ts";
export { z } from "zod";
export type { AgentTool, ExecutionEnv, Skill, SkillDiagnostic } from "@earendil-works/pi-agent-core";
/**
 * A conversation record, as the tool runtime and the control plane hold it. Its entries are pi's own
 * — exported under a qualified name because `SessionEntry` in this package is the NEUTRAL one the
 * control plane publishes (session.ts), and the two are different shapes.
 */
export type { SessionManager, SessionEntry as PiSessionEntry } from "@earendil-works/pi-coding-agent";

export {
  createPiAgentFromDir,
  type CreatePiAgentFromDirOptions,
} from "./engines/pi/open.ts";
export type { LoadedDefinition, SkillCollision } from "./engines/pi/definition.ts";

export {
  defineConfig,
  listModels,
  resolveModel,
  type FastagentConfig,
} from "./engines/pi/config.ts";
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
// Types only: they appear in our signatures, so a caller must be able to name them. `createProvider`
// is pi-ai's own runtime function — forwarding it would make us answerable for its API without
// adding anything; import it from `@earendil-works/pi-ai` directly.
export type { Provider, ProviderAuth } from "@earendil-works/pi-ai";
export type { Model } from "@earendil-works/pi-ai";

// The product's one-call assembly: a directory becomes a live service. On the pi surface because
// it opens a directory the pi way (channels, schedules, the assembled agent).
export { createAgentService, type CreateAgentServiceOptions } from "./engines/pi/service.ts";
