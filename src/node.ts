/**
 * Binding a Fetch handler to a Node HTTP server.
 *
 * Its own entry point because it is the one piece of the neutral surface that is RUNTIME-specific:
 * `@hono/node-server` bridges `node:http` ↔ Fetch, and that package is the only third-party weight
 * anywhere behind `/core`. Keeping it here lets a channel package or another engine import the
 * contract without pulling a Node HTTP bridge it will never call — and lets a non-Node runtime
 * (Workers, Deno, Bun's own server) consume `/core` unchanged.
 *
 * Engine-neutral is not the same as runtime-neutral, and the two properties give the surface its
 * three layers: `/core` is both (contract, fetch-shaped kit), `/node` is engine-neutral only (this
 * file: the assembly and the HTTP binding, which need a filesystem, a clock and an environment),
 * `/pi` is neither (it names an engine).
 */
export { nodeListener, serveNode } from "./channels/serve.ts";

// The assembly: a MountableAgent becomes a mounted service. Engine-neutral — it reads the SPEC
// contract plus three paths, so a second engine reuses it with its own opener — but NOT runtime
// neutral: it reads a directory, a cron and an environment. That is what makes this its entry
// rather than `/core`.
export {
  mountAgentService,
  type AgentService,
  type MountableAgent,
  type MountAgentServiceOptions,
} from "./service.ts";
