// Naming conventions across this surface:
//   - Agent-level entry points: `create…From<input granularity>` (the assembly ladder, see create.ts);
//   - leaf part constructors read as the part itself (inProcessLease → Lease, piHarnessFactory → PiHarnessFactory);
//   - resolve* = multi-source precedence decisions; load* = disk → memory (result: Loaded*);
//   - pi-coupled exports carry pi/Pi; Config = user-authored file shape, Options = function inputs.
// Module organization: by lifecycle moment + domain — create.ts = configuration time
// (parts + ladder), invoke.ts = request time (turn mechanism), definition.ts = the
// definition data domain, config.ts/auth.ts = composition-root support.

// Protocol contract (neutral, engine-free)
export type { Agent, AgentEvent, ImageRef, Json, Prompt, Scope } from "./agent.ts";
export { collect, AgentFailure, type CollectResult } from "./collect.ts";

// Channels (N-side; consume only the Agent contract)
export { createInvokeHandler } from "./channels/http.ts";

// pi reference implementation — assembly ladder (L1/L2/L3; L0 below)
export {
  createPiAgent,
  createPiAgentFromDefinition,
  createPiAgentFromWorkspace,
  type CreatePiAgentOptions,
  type CreatePiAgentFromDefinitionOptions,
  type CreatePiAgentFromWorkspaceOptions,
} from "./engines/pi/create.ts";

// pi reference implementation — definition domain (load / bundle)
export {
  loadAgentDefinition,
  bundleAgentDefinition,
  defaultGlobalSkillPaths,
  type LoadedDefinition,
  type LoadAgentDefinitionOptions,
  type SkillCollision,
} from "./engines/pi/definition.ts";

// pi reference implementation — build (compile a workspace into a deployable artifact)
export {
  buildPiArtifact,
  type ArtifactManifest,
  type BuildPiArtifactOptions,
} from "./engines/pi/build.ts";

// pi reference implementation — engine assets (prompt base + toolsets, in create.ts).
// Internal assembly helpers (assembleSystemPrompt, resolveTools) are NOT public:
// the ladder rungs own assembly; embedders compose via L1/L2/L3.
export {
  piBasePrompt,
  piDefaultTools,
  piReadOnlyTools,
} from "./engines/pi/create.ts";

// pi reference implementation — config subsystem.
// loadConfig is internal (L3 owns config loading); resolveModel bridges a
// "provider/modelId" string to a model for L1/L2 embedders.
export {
  defineConfig,
  resolveModel,
  type FastagentConfig,
} from "./engines/pi/config.ts";

// pi reference implementation — injection ports referenced by the ladder options.
// L0 (createPiAgentFromHarness) and the pi harness-factory wiring are deliberately
// NOT exported: they expose pi's two-port shape and would pin the engine-coupled
// surface as a public promise before engine #2 exists. Reach them via internal
// modules for custom wiring/tests.
export {
  type Lease,
  type Release,
  inProcessLease,
} from "./engines/pi/invoke.ts";
export type { AnyModel } from "./engines/pi/harness.ts";
export {
  type PiSessionStore,
  inMemorySessionStore,
  jsonlSessionStore,
} from "./engines/pi/sessions.ts";
export {
  type Auth,
  type AuthResolver,
  type PiAuthOptions,
  envAuth,
  piOAuthAuth,
  resolvePiAuth,
} from "./engines/pi/auth.ts";
