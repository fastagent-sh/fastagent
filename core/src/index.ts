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
// createInvokeHandler is Fetch-shaped ((Request) => Promise<Response>) so it mounts in any host
// route; nodeListener bridges it onto node:http for the standalone server.
export { createInvokeHandler, nodeListener } from "./channels/http.ts";
// Webhook channel (N): the ACK-early topology — 202 now, run the turn via the `background` port,
// deliver out-of-band. Consumes only the Agent contract. `background` is the Caller-side host port
// (execution lifetime); createTrackedBackground is the single-instance reference impl.
export { createWebhookHandler, type WebhookBinding } from "./channels/webhook.ts";
export { type BackgroundRunner, createTrackedBackground } from "./channels/background.ts";

// pi reference implementation — reusable assembly ladder (L1/L2; L0 below)
export {
  createPiAgent,
  createPiAgentFromDefinition,
  type CreatePiAgentOptions,
  type CreatePiAgentFromDefinitionOptions,
} from "./engines/pi/create.ts";

// pi reference implementation — init (scaffold a minimal runnable workspace).
export { scaffoldWorkspace, type ScaffoldResult } from "./engines/pi/init.ts";

// pi reference implementation — tool authoring: defineTool (+ re-exported z) and tools/ discovery.
export {
  defineTool,
  loadTools,
  type DefineToolOptions,
  type ToolContext,
  type ToolCollision,
} from "./engines/pi/tool.ts";
export { z } from "zod";

// pi reference implementation — dev (open a workspace into an agent, authoring posture).
// The command opener that composes over L2; sibling of createPiAgentFromArtifact (start).
export {
  createPiAgentFromWorkspace,
  type CreatePiAgentFromWorkspaceOptions,
} from "./engines/pi/dev.ts";

// pi reference implementation — definition domain (load).
// bundleAgentDefinition is intentionally NOT exported: it does a destructive `rm -rf
// outDir` and the overwrite guard lives in buildPiArtifact, the public build entry point.
export {
  loadAgentDefinition,
  defaultGlobalSkillPaths,
  type LoadedDefinition,
  type LoadAgentDefinitionOptions,
  type SkillCollision,
} from "./engines/pi/definition.ts";

// pi reference implementation — build (compile a workspace into a self-contained artifact)
export {
  buildPiArtifact,
  type ArtifactManifest,
  type BuildPiArtifactOptions,
} from "./engines/pi/build.ts";

// pi reference implementation — start (run a built artifact in production posture).
// Deploy-time sibling of L3 createPiAgentFromWorkspace; both are thin orchestrations over L2.
export {
  createPiAgentFromArtifact,
  loadManifest,
  type CreatePiAgentFromArtifactOptions,
} from "./engines/pi/start.ts";

// pi reference implementation — engine assets (prompt base + toolsets, in create.ts).
// Internal assembly helpers (assembleSystemPrompt, resolveTools) are NOT public:
// the ladder rungs own assembly; embedders compose via L1/L2/L3.
export { piBasePrompt, piDefaultTools } from "./engines/pi/create.ts";

// pi reference implementation — config subsystem.
// loadConfig is internal (L3 owns config loading); resolveModel bridges a
// "provider/modelId" string to a model for L1/L2 embedders.
export {
  defineConfig,
  resolveModel,
  listModels,
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
// ExecutionEnv is the K-axis env port referenced by the ladder's `env` option (L1/L2): export the
// type so embedders can inject a sandbox env without reaching into pi-agent-core directly.
export type { ExecutionEnv } from "@earendil-works/pi-agent-core";
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
  probeAuthSource,
  resolvePiAuth,
} from "./engines/pi/auth.ts";
