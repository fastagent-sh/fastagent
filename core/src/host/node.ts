/**
 * Node host (K-axis): mount a route table of Fetch handlers on a node:http server. Post-ACK work
 * (e.g. a webhook channel's fire-and-forget turns) runs on this process's event loop and is lost on
 * shutdown (the accepted tradeoff until durable execution exists).
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { nodeListener } from "../channels/http.ts";
import { text } from "../channels/respond.ts";

/** A mounted request handler (a channel's fetch, or a plain route like health). */
export type ChannelHandler = (req: Request) => Response | Promise<Response>;

/** This deployment's HTTP surface: route key → handler. Key is `"/path"` or `"METHOD /path"`. */
export type Routes = Record<string, ChannelHandler>;

/** Parse a route key: `"METHOD /path"` → `{ method, path }`, or `"/path"` → `{ path }` (any method). */
function parseRouteKey(key: string): { method?: string; path: string } {
  const sp = key.indexOf(" ");
  return sp === -1 ? { path: key } : { method: key.slice(0, sp).toUpperCase(), path: key.slice(sp + 1) };
}

/**
 * Compose a {@link Routes} table into one handler: exact pathname match (optionally method-qualified),
 * 405 when the path exists under another method, 404 otherwise. No params/wildcards — channels mount
 * at fixed paths.
 */
export function router(routes: Routes): ChannelHandler {
  const entries = Object.entries(routes).map(([key, handler]) => ({ ...parseRouteKey(key), handler }));
  return (req) => {
    const { pathname } = new URL(req.url);
    const onPath = entries.filter((e) => e.path === pathname);
    if (onPath.length === 0) return text("not found\n", 404);
    const match = onPath.find((e) => e.method === undefined || e.method === req.method);
    if (!match) return text("method not allowed\n", 405);
    return match.handler(req);
  };
}

/**
 * Serve `handler` on a Node HTTP server. Thin mechanism: bind, report the port, and let the caller
 * close it — no logging, signal handling, or process.exit (the CLI / app entry owns those).
 * `listening` resolves with the bound port (useful for port 0) or rejects on a bind error (EADDRINUSE).
 */
export function serveNode(
  handler: ChannelHandler,
  options: { port: number },
): { listening: Promise<number>; close: () => Promise<void> } {
  const server = createServer(nodeListener(async (req) => handler(req)));
  const listening = new Promise<number>((resolve, reject) => {
    server.once("error", reject); // a bind failure surfaces here, before "listening"
    server.listen(options.port, () => {
      server.off("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
  const close = () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  return { listening, close };
}
