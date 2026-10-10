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

// What an agent works on and knows: the declaration, where each content entry is for this instance, and the clone that makes
// a repository with no checkout here real.
export type { ContentDeclaration } from "./content/declare.ts";
export { cloneContent, resolveContent, type ResolvedContent } from "./content/resolve.ts";
// A directory or `github:owner/repo` read as a declaration, the way `init --content` and `content add` read it.
export { declarationFor, type SourceOptions } from "./content/source.ts";
