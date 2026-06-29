// Naming: `create…From<input>` = the assembly ladder; `resolve*` = multi-source precedence;
// `load*` = disk → memory (→ `Loaded*`); pi-coupled names carry `pi`/`Pi`; `Config` = user file
// shape, `Options` = function inputs.

// Protocol contract (neutral, engine-free)
export type { Agent, AgentEvent, ImageRef, Json, Prompt, Scope } from "./agent.ts";
export { collect, AgentFailure, type CollectResult } from "./collect.ts";

// Channels (N-side; consume only the Agent contract). createInvokeHandler is Fetch-shaped so it
// mounts in any host route; nodeListener bridges it onto node:http. The GitHub channel is a subpath
// export: `@kid7st/fastagent/github`.
export { createInvokeHandler, nodeListener } from "./channels/http.ts";
// Channel-authoring kit: an adapter (built-in, or a third-party `fastagent-channel-*` package) needs
// these to read a capped request body and build plain responses — so it depends only on
// @kid7st/fastagent. `collect` (below) drives the turn; `Routes`/`ChannelHandler` (host) type the return.
export { readBodyCapped } from "./channels/body.ts";
export { text, textHeaders } from "./channels/respond.ts";

// Node host (K-side). serveNode binds a route table on node:http; router composes a Routes table.
export { type ChannelHandler, type Routes, router, serveNode } from "./host/node.ts";

// pi reference implementation — the reusable assembly ladder (L1/L2; L0 is internal to invoke.ts).
export {
  createPiAgent,
  createPiAgentFromDefinition,
  type CreatePiAgentOptions,
  type CreatePiAgentFromDefinitionOptions,
} from "./engines/pi/create.ts";

// init: scaffold a runnable workspace.
export { scaffoldWorkspace, type ScaffoldResult } from "./engines/pi/scaffold/init.ts";

// Tool authoring: defineTool (+ re-exported z) and tools/ discovery.
// Re-export rule: the engine-neutral contract (agent.ts) owns its types; the pi reference-impl
// surface is openly engine-coupled, so every pi type that appears in its signatures is re-exported
// (named, never `export *`) so embedders never reach into `@earendil-works/*`. Author tool schemas
// with the `z` re-exported here (one zod copy — see DefineToolOptions).
export {
  defineTool,
  loadTools,
  type DefineToolOptions,
  type ToolContext,
  type ToolCollision,
} from "./engines/pi/tool.ts";
export { z } from "zod";
export type { AgentTool } from "@earendil-works/pi-agent-core";

// Channel discovery: a channels/<name>.ts default-exports a ChannelModule ((agent) => Routes).
export { loadChannels, type ChannelModule, type ChannelCollision } from "./engines/pi/channel.ts";

// The command opener `dev` and `start` both drive: point at a definition directory → agent.
export {
  createPiAgentFromWorkspace,
  type CreatePiAgentFromWorkspaceOptions,
} from "./engines/pi/workspace.ts";

// Definition domain (load).
export {
  loadAgentDefinition,
  type LoadedDefinition,
  type LoadAgentDefinitionOptions,
  type SkillCollision,
} from "./engines/pi/definition.ts";
export type { Skill, SkillDiagnostic } from "@earendil-works/pi-agent-core";

// Engine assets (prompt base + toolset). Internal assembly helpers (assembleSystemPrompt,
// resolveTools) are NOT public: the ladder rungs own assembly.
export { piBasePrompt, piDefaultTools } from "./engines/pi/create.ts";

// Config subsystem. loadConfig is internal (L3 owns config loading); resolveModel bridges a
// "provider/modelId" string to a model for L1/L2 embedders.
export {
  defineConfig,
  resolveModel,
  listModels,
  type FastagentConfig,
} from "./engines/pi/config.ts";

// Injection ports referenced by the ladder options. L0 (createPiAgentFromHarness) and the pi
// harness-factory wiring are deliberately NOT exported (they would pin pi's engine-coupled shape as
// a public promise before engine #2 exists); reach them via internal modules for custom wiring/tests.
export {
  type Lease,
  type Release,
  inProcessLease,
} from "./engines/pi/invoke.ts";
export type { AnyModel } from "./engines/pi/harness.ts";
// ExecutionEnv is the K-axis env port referenced by the ladder's `env` option.
export type { ExecutionEnv } from "@earendil-works/pi-agent-core";
export {
  type PiSessionStore,
  inMemorySessionStore,
  jsonlSessionStore,
} from "./engines/pi/sessions.ts";
// Session is pi's session object that PiSessionStore.openOrCreate returns (custom stores produce it).
export type { Session } from "@earendil-works/pi-agent-core";
// Auth + the Models collection. createPiModels builds the default collection (built-in providers;
// ~/.fastagent/auth.json → env vars); fastagentCredentialStore is the read-write store fastagent owns.
export { FASTAGENT_AUTH_PATH, type FastagentAuthOptions, fastagentCredentialStore } from "./engines/pi/auth.ts";
export { type CreatePiModelsOptions, createPiModels, probeAuthSource } from "./engines/pi/models.ts";
export type { Models } from "@earendil-works/pi-ai";
// Provider injection (Tier 2: your own gateway / self-hosted endpoint), passed via the `providers`
// option. createProvider builds one from parts; its wire-protocol `api` comes from
// `@earendil-works/pi-ai/api/*`. Most agents never touch this — a `model` spec selects a built-in.
export { createProvider, type Provider, type ProviderAuth } from "@earendil-works/pi-ai";
// Model is the model descriptor a createProvider({ models }) author supplies.
export type { Model } from "@earendil-works/pi-ai";
