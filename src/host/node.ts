/**
 * Node host (K-axis): mount a route table of Fetch handlers on a node:http server. Post-ACK work
 * (e.g. a webhook channel's fire-and-forget turns) runs on this process's event loop and is lost on
 * shutdown (the accepted tradeoff until durable execution exists).
 *
 * Hono is the routing/adapter mechanism INSIDE this file and never leaves it. The types a channel
 * author or an embedder writes stay pure Fetch (`ChannelHandler`, `Routes`) — SPEC §11 fixes the
 * gateway contract as `(Request) => Response`, a channel directory ships hand-written modules with
 * that signature, and an app embedding fastagent may already run Express/Fastify/its own Hono. What
 * we must not do is pick their framework for them.
 *
 * `overrideGlobalObjects: false` is part of that containment, not a tuning knob. The adapter
 * otherwise swaps `globalThis.Request`/`Response` for its own, which reaches every line in the
 * embedding process — and breaks code here first: a channel holding a `Response` captured before
 * mount fails the `instanceof` check in {@link totalFetch} and is answered 500, the totality
 * boundary rejecting a CORRECT handler.
 */
import { serve, getRequestListener } from "@hono/node-server";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { Hono } from "hono";
import type { Agent } from "../agent.ts";
import type { SessionControl } from "../session.ts";
import { log } from "../log.ts";
import { text } from "../channels/respond.ts";

/** A mounted request handler (a channel's fetch, or a plain route like health). */
export type ChannelHandler = (req: Request) => Response | Promise<Response>;

/** This deployment's HTTP surface: route key → handler. Key is `"/path"` or `"METHOD /path"`. */
export type Routes = Record<string, ChannelHandler>;

/**
 * What the framework hands a channel at mount time: the assembled agent plus the resolved state ROOT
 * (absolute; `FASTAGENT_STATE_DIR` > `<root>/.state`). Channels derive their OWN durable home from
 * it (`<stateRoot>/channels/<kind>/`) — they never anchor on `process.cwd()`. env is the OPERATOR
 * input plane; this context is how the resolved result reaches code (embedders without the agent
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
 * The path language a {@link Routes} key speaks: a LITERAL path, or a PREFIX mount ending in `/*`
 * that owns everything beneath it (the session control plane is one).
 *
 * Deliberately narrower than the matcher underneath, which would also accept parameter patterns
 * (`/x/:id`). The reason is {@link routePathsOverlap}: two channels must never silently shadow each
 * other, so "do these two routes overlap?" has to be decidable — and for arbitrary patterns it is
 * not. Widening this language means answering that question first.
 */
export function assertRoutePath(path: string, describe: (problem: string) => string): void {
  if (!path.startsWith("/")) throw new Error(describe('must start with "/"'));
  if (path.includes(":")) throw new Error(describe("parameter patterns (:id) are not supported"));
  const star = path.indexOf("*");
  if (star !== -1 && path !== `${path.slice(0, star - 1)}/*`) {
    throw new Error(describe('"*" is only allowed as a trailing "/*" prefix mount'));
  }
}

/** The prefix a `/*` mount owns, or undefined for a literal path. */
function mountPrefix(path: string): string | undefined {
  return path.endsWith("/*") ? path.slice(0, -2) : undefined;
}

/**
 * Would these two route paths answer the same request? THE overlap question, asked in one place so
 * every caller that must refuse a collision (channel loading, control-plane mounting) refuses the
 * same set. A literal pair collides when equal; a prefix mount collides with anything beneath it,
 * including a path it does not itself serve — the request would still reach the mount's own 404
 * instead of the other channel.
 */
export function routePathsOverlap(a: string, b: string): boolean {
  const pa = mountPrefix(a);
  const pb = mountPrefix(b);
  const under = (prefix: string, path: string) => path === prefix || path.startsWith(`${prefix}/`);
  if (pa !== undefined && pb !== undefined) return under(pa, pb) || under(pb, pa);
  if (pa !== undefined) return under(pa, b);
  if (pb !== undefined) return under(pb, a);
  return a === b;
}

/**
 * Compose a {@link Routes} table into one handler: path match (optionally method-qualified),
 * 405 when the path exists under another method, 404 otherwise.
 *
 * The 404/405 split is load-bearing, not cosmetic: a remote client reads 404 as "this serve predates
 * the route" (version skew) and anything else as a fault, so collapsing them — which is what Hono
 * does on its own, answering 404 for a method mismatch — would misreport an old deployment as a
 * broken one. `notFound` restores it from the table, which knows every path it mounted.
 */
export function router(routes: Routes): ChannelHandler {
  const app = new Hono();
  const paths: string[] = [];
  for (const [key, handler] of Object.entries(routes)) {
    const { method, path } = parseRouteKey(key);
    if (!paths.includes(path)) paths.push(path);
    const bound = (c: { req: { raw: Request } }) => handler(c.req.raw);
    if (method) app.on(method, path, bound);
    else app.all(path, bound);
  }
  // "The path exists" is decided by the SAME matcher that dispatches, never by comparing pathname
  // strings: a pattern route (`POST /x/*`) matches paths no literal comparison would recognise, and
  // the two answers drifting apart is exactly how a method miss starts reporting itself as 404 —
  // which a remote client reads as version skew rather than as its own mistake. Registered after
  // the method-qualified routes, so it is only reached when the path matched and the method did not.
  for (const path of paths) app.all(path, () => text("method not allowed\n", 405));
  app.notFound(() => text("not found\n", 404));
  return (req) => app.fetch(req);
}

/**
 * The TOTALITY boundary every serving path shares, and not decoration: `loadChannels` imports
 * arbitrary author code, so a channel that throws — or simply forgets to return — must become a
 * logged 500 rather than escape as an unhandled rejection. Both the exported listener and
 * `serveNode` route through it; wiring only one would leave the path `dev`/`start` actually use
 * failing silently while the exported one looked correct.
 *
 * The message stays internal (rule 8 is about the LOG being visible, not the client): an adapter's
 * default error page would otherwise echo exception text — a stack, a path, a key inside an error
 * string — straight to whoever made the request.
 */
function totalFetch(handler: ChannelHandler): (req: Request) => Promise<Response> {
  return async (req) => {
    try {
      const response = await handler(req);
      if (!(response instanceof Response)) throw new TypeError("handler did not return a Response");
      return response;
    } catch (error) {
      log.error(`[host] request failed: ${String(error)}`);
      return text("internal error\n", 500);
    }
  };
}

/** The node:http adapter for a Fetch handler — the embedded server uses it, and an embedder mounting
 *  fastagent on its OWN node:http server can too. */
export function nodeListener(
  handler: (req: Request) => Promise<Response>,
): (req: IncomingMessage, res: ServerResponse) => void {
  return getRequestListener(totalFetch(handler), { overrideGlobalObjects: false });
}

/**
 * Serve `handler` on a Node HTTP server. Thin mechanism: bind, report the port, let the caller stop
 * accepting or force-close active connections — no logging/signals/exit (the CLI owns those).
 * `listening` resolves with the bound port (useful for port 0) or rejects on a bind error.
 * `host` is the bind address; unset means all interfaces (what containers need).
 */
export function serveNode(
  handler: ChannelHandler,
  options: { port: number; host?: string },
): { listening: Promise<number>; close: () => Promise<void>; closeAllConnections: () => void } {
  let onListening!: (port: number) => void;
  let onBindError!: (error: Error) => void;
  const listening = new Promise<number>((resolve, reject) => {
    onListening = resolve;
    onBindError = reject;
  });
  // serve() types its return as the union of every server it CAN build (incl. http2). We never pass
  // a createServer/http2 option, so it is always node:http's Server — the one carrying
  // closeAllConnections, which the caller-owned force-close depends on.
  const server = serve(
    {
      fetch: totalFetch(handler),
      overrideGlobalObjects: false,
      port: options.port,
      ...(options.host !== undefined ? { hostname: options.host } : {}),
    },
    (info) => {
      // Detach before resolving: this listener answers the BIND, and leaving it attached would let
      // a later runtime error call reject() on a settled promise — swallowed, with nothing raised
      // anywhere. Detached, an error after bind is an unhandled 'error' event, which is loud.
      // (Not reachable from a test without forging an event on a server this function does not
      // expose; the bind-failure half below is covered.)
      server.off("error", onBindError);
      onListening(info.port);
    },
  ) as Server;
  server.once("error", onBindError); // a bind failure surfaces here, before "listening"
  const close = () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  const closeAllConnections = (): void => server.closeAllConnections();
  return { listening, close, closeAllConnections };
}
