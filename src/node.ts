/**
 * Binding a Fetch handler to a Node HTTP server.
 *
 * Its own entry point because it is the one piece of the neutral surface that is RUNTIME-specific:
 * `@hono/node-server` bridges `node:http` ↔ Fetch, and that package is the only third-party weight
 * anywhere behind `/core`. Keeping it here lets a channel package or another engine import the
 * contract without pulling a Node HTTP bridge it will never call — and lets a non-Node runtime
 * (Workers, Deno, Bun's own server) consume `/core` unchanged.
 *
 * Engine-neutral is not the same as runtime-neutral; `/core` is both, and this is where the second
 * one is spent.
 */
export { nodeListener, serveNode } from "./channels/serve.ts";
