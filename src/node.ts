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

// What an agent works on and knows: its `context.json`, where each entry is for this instance, and the clone that makes
// a repository with no checkout here real.
export type {
  BoundContent,
  ContentBinding,
  ContentDeclaration,
  ContentEntry,
  DeclaredContent,
} from "./content/declare.ts";
export { loadContent, loadContexts } from "./content/file.ts";
// The contexts an agent uses: what its context.json lists, fetched into `.contexts/` and reported as fetched there.
export type { ContextEntry, DeclaredContext } from "./contexts/declare.ts";
export { type ContextFetch, type FetchedContext, fetchContexts, fetchedContexts } from "./contexts/fetch.ts";
export { cloneContent, contentAbsentHere, resolveContent, type ResolvedContent } from "./content/resolve.ts";
// A directory or `github:owner/repo` read as an addition, the way `init --content` and `content add` read it.
export { type ContentAddition, readContentSource, type SourceOptions } from "./content/source.ts";
