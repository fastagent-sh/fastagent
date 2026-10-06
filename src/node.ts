/** Binding a Fetch handler to a Node HTTP server. */
export { nodeListener, serveNode } from "./channels/serve.ts";

// The assembly: a MountableAgent becomes a mounted service.
export {
  mountAgentService,
  type AgentService,
  type HttpSurface,
  type MountableAgent,
  type MountAgentServiceOptions,
} from "./service.ts";

// What an agent works on and knows: the declaration, where each context is for this instance, and the clone that makes
// a repository with no checkout here real.
export type { ContextDeclaration } from "./contexts/declare.ts";
export { cloneContext, resolveContexts, type ResolvedContext } from "./contexts/resolve.ts";
// A directory or `github:owner/repo` read as a declaration, the way `init --context` and `context add` read it.
export { declarationFor, type SourceOptions } from "./contexts/source.ts";
