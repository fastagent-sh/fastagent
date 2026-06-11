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

// pi reference implementation — engine assets & prompt assembly (in create.ts)
export {
  piBasePrompt,
  assembleSystemPrompt,
  type AssembleSystemPromptOptions,
  piDefaultTools,
  piReadOnlyTools,
  resolveTools,
} from "./engines/pi/create.ts";

// pi reference implementation — config subsystem
export {
  defineConfig,
  loadConfig,
  resolveModel,
  type FastagentConfig,
  type LoadedConfig,
} from "./engines/pi/config.ts";

// pi reference implementation — low-level building blocks (escape hatch; L0)
export {
  createPiAgentFromHarness,
  type CreatePiAgentFromHarnessOptions,
  type Lease,
  type Release,
  inProcessLease,
  type RetryClassifier,
  defaultRetryClassifier,
} from "./engines/pi/invoke.ts";
export {
  piHarnessFactory,
  type AnyModel,
  type PiHarnessFactory,
  type PiHarnessFactoryOptions,
  type SessionRepoLike,
} from "./engines/pi/harness.ts";
export {
  type Auth,
  type AuthResolver,
  type PiAuthOptions,
  envAuth,
  piOAuthAuth,
  resolvePiAuth,
} from "./engines/pi/auth.ts";
