/**
 * Node host (K-axis): mount a route table of Fetch handlers on a node:http server. Post-ACK work
 * (e.g. a webhook channel's fire-and-forget turns) runs on this process's event loop and is lost on
 * shutdown (the accepted tradeoff until durable execution exists).
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Agent } from "../agent.ts";
import type { SessionControl } from "../session.ts";
import { nodeListener } from "../channels/http.ts";
import { text } from "../channels/respond.ts";

/** A mounted request handler (a channel's fetch, or a plain route like health). */
export type ChannelHandler = (req: Request) => Response | Promise<Response>;

/** This deployment's HTTP surface: route key → handler. Key is `"/path"` or `"METHOD /path"`. */
export type Routes = Record<string, ChannelHandler>;

/**
 * What the framework hands a channel at mount time: the assembled agent plus the resolved state ROOT
 * (absolute; `FASTAGENT_STATE_DIR` > `<root>/.state`). Channels derive their OWN durable home from
 * it (`<stateRoot>/channels/<kind>/`) — they never anchor on `process.cwd()`. env is the OPERATOR
 * input plane; this context is how the resolved result reaches code (embedders without the workspace
 * opener construct it explicitly).
 */
export interface ChannelContext {
  agent: Agent;
  stateRoot: string;
  /** The serving session-control hub, when the serve wires one (`config.sessionControl`). Channels
   *  use it for DISPATCH only (the user-facing stop command); observation stays on the data plane. */
  control?: SessionControl;
}

/** A `channels/<name>.ts` route channel: receives mount context and returns its HTTP routes. */
export type ChannelModule = (ctx: ChannelContext) => Routes;

/** One logical long connection's lifecycle. `ready` settles after its first usable connection — and
 * when `signal` aborts before one exists it must still settle: resolution then means cancellation, not
 * readiness (the server skips ready-side effects once the signal is aborted; it must never hang).
 * `closed` resolves after abort-driven shutdown and rejects on a terminal connection failure. */
export interface LongConnection {
  ready: Promise<void>;
  closed: Promise<void>;
}

/** A long-connection channel is an explicit module object rather than an HTTP-route factory.
 * The adapter owns reconnects and treats `signal` as its sole shutdown command. */
export interface LongConnectionChannelModule {
  name: string;
  connect(ctx: ChannelContext, signal: AbortSignal): LongConnection;
}

/** Parse a route key: `"METHOD /path"` → `{ method, path }`, or `"/path"` → `{ path }` (any method). */
export function parseRouteKey(key: string): { method?: string; path: string } {
  const sp = key.indexOf(" ");
  return sp === -1 ? { path: key } : { method: key.slice(0, sp).toUpperCase(), path: key.slice(sp + 1) };
}

/**
 * Compose a {@link Routes} table into one handler: exact pathname match (optionally method-qualified),
 * 405 when the path exists under another method, 404 otherwise. No params/wildcards.
 */
export function router(routes: Routes): ChannelHandler {
  const entries = Object.entries(routes).map(([key, handler]) => ({
    ...parseRouteKey(key),
    handler,
  }));
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
 * Serve `handler` on a Node HTTP server. Thin mechanism: bind, report the port, let the caller stop
 * accepting or force-close active connections — no logging/signals/exit (the CLI owns those).
 * `listening` resolves with the bound port (useful for port 0) or rejects on a bind error.
 */
export function serveNode(
  handler: ChannelHandler,
  options: { port: number },
): { listening: Promise<number>; close: () => Promise<void>; closeAllConnections: () => void } {
  const server = createServer(nodeListener(async (req) => handler(req)));
  const listening = new Promise<number>((resolve, reject) => {
    server.once("error", reject); // a bind failure surfaces here, before "listening"
    server.listen(options.port, () => {
      server.off("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
  const close = () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  const closeAllConnections = (): void => server.closeAllConnections();
  return { listening, close, closeAllConnections };
}
