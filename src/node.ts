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

// What an agent works on and knows: the declaration, and where each context is for this instance.
export type { ContextDeclaration } from "./contexts/declare.ts";
export { resolveContexts, type ResolvedContext } from "./contexts/resolve.ts";
