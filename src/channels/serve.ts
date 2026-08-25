/**
 * How a {@link Routes} table becomes a running server: the route path language, the matcher, the
 * totality boundary, and the node:http binding.
 *
 * This is shared ground, not a deployment target. Every host in `src/deploy/` — docker, fly,
 * railway, agentcore — ships the same container running the same Node process serving the same
 * route table; what differs between them is process, storage, credentials and deployment
 * (core.md §1), none of which is here. So this file sits with the channels it serves, next to
 * `body.ts`/`respond.ts`/`state.ts`, rather than pretending to be one runtime among several.
 *
 * Hono is the routing/adapter mechanism INSIDE this file and never leaves it. The types a channel
 * author or an embedder writes stay pure Fetch (`ChannelHandler`, `Routes` in `../channel.ts`) —
 * SPEC §11 fixes the gateway contract as `(Request) => Response`, an agent directory ships
 * hand-written modules with that signature, and an app embedding fastagent may already run
 * Express/Fastify/its own Hono. What we must not do is pick their framework for them.
 *
 * `overrideGlobalObjects: false` is part of that containment, not a tuning knob. The adapter
 * otherwise swaps `globalThis.Request`/`Response` for its own, which reaches every line in the
 * embedding process — and breaks code here first: a channel holding a `Response` captured before
 * mount fails the `instanceof` check in {@link totalFetch} and is answered 500, the totality
 * boundary rejecting a CORRECT handler.
 *
 * Post-ACK work (a webhook channel's fire-and-forget turns) runs on this process's event loop and is
 * lost on shutdown — the accepted tradeoff until durable execution (the K axis) exists.
 */
import { serve, getRequestListener } from "@hono/node-server";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { Hono } from "hono";
import type { ChannelHandler, Routes } from "../channel.ts";
import { log } from "../log.ts";
import { text } from "./respond.ts";

/**
 * Parse a route key: `"METHOD /path"` → `{ method, path }`, or `"/path"` → `{ path }` (any method).
 *
 * An empty method normalises to `undefined` rather than `""`. A leading space (`" /x"`) is the way
 * to produce one, and the two values are not interchangeable to every reader: `""` is falsy, so the
 * router treated it as any-method, while the collision check compared it as a method and found no
 * clash with `"GET /x"` — letting the pair coexist, then shadow each other at runtime. One
 * representation for one meaning, decided here so no caller has to know the difference.
 */
export function parseRouteKey(key: string): { method?: string; path: string } {
  const sp = key.indexOf(" ");
  if (sp === -1) return { path: key };
  const method = key.slice(0, sp).toUpperCase();
  return method ? { method, path: key.slice(sp + 1) } : { path: key.slice(sp + 1) };
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
export function assertRouteKey(key: string, describe: (problem: string) => string): void {
  const { method, path } = parseRouteKey(key);
  // HEAD is not a method you can route here: the matcher answers HEAD from the GET route (RFC 9110)
  // and never reaches an explicitly registered HEAD handler — verified in both registration orders,
  // and a HEAD-only route 404s outright. Refusing it says so at mount instead of leaving an author
  // with a handler that silently never runs.
  if (method === "HEAD") {
    throw new Error(describe("HEAD is served by the GET route (RFC 9110); an explicit HEAD route never runs"));
  }
  if (!path.startsWith("/")) throw new Error(describe('must start with "/"'));
  // Percent-encoding is refused for the same reason HEAD is — it does not do what it looks like it
  // does. Request paths are DECODED before matching, so a `/%63ontrol` route is unreachable by any
  // ordinary request, while overlap checks (which compare the raw strings) would read it as a
  // distinct path and let it past the collision rule that keeps channels from shadowing each other.
  if (path.includes("%")) {
    throw new Error(describe("percent-encoding is not allowed in a route path — write the decoded path"));
  }
  // A key is a PATH. `?`/`#` start the query and fragment, which never reach the matcher, so such a
  // route is registered, looks mounted, and answers nothing — the same dead-code shape as HEAD.
  const marker = ["?", "#"].find((ch) => path.includes(ch));
  if (marker) {
    throw new Error(describe(`"${marker}" is not part of a path — a route key is a path, without query or fragment`));
  }
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
 * Would these two route KEYS fight over the same request? The complete question — paths overlap AND
 * methods are compatible — asked in one place because it has one answer, and because the half of it
 * that lived in callers is exactly the half that drifted.
 *
 * A key with no method answers every method, so it is compatible with all of them.
 */
export function routeKeysOverlap(a: string, b: string): boolean {
  const ka = parseRouteKey(a);
  const kb = parseRouteKey(b);
  if (!routePathsOverlap(ka.path, kb.path)) return false;
  return ka.method === undefined || kb.method === undefined || ka.method === kb.method;
}

/**
 * Would these two route paths answer the same request? A literal pair collides when equal; a prefix
 * mount collides with anything beneath it, including a path it does not itself serve — the request
 * would still reach the mount's own 404 instead of the other channel. Method-blind: {@link
 * routeKeysOverlap} is what callers comparing whole keys should ask.
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
 * broken one.
 */
export function router(routes: Routes): ChannelHandler {
  const app = new Hono();
  const paths: string[] = [];
  const registered: string[] = [];
  for (const [key, handler] of Object.entries(routes)) {
    const { method, path } = parseRouteKey(key);
    // Enforced HERE, not only where channel files are loaded: this is the other door into the
    // router, and an embedder passing `Routes` directly would otherwise reach the matcher's full
    // pattern syntax. A `:param` route would still MATCH, while routePathsOverlap — which every
    // collision check depends on — reads it as a literal string and silently answers wrong.
    assertRouteKey(key, (problem) => `route "${key}" is not a valid route key — ${problem}`);
    // Same door, same reason: a table where two keys fight over a request resolves by registration
    // order, so one of them simply never runs. `loadChannels` reports that across FILES (naming the
    // loser); within a single table it is a plain configuration error, and refusing it here is what
    // makes "a prefix mount owns everything beneath it" true for every caller, not just for channel
    // directories.
    const shadowed = registered.find((other) => routeKeysOverlap(other, key));
    if (shadowed) {
      throw new Error(`route "${key}" overlaps "${shadowed}" — one of them would never receive a request`);
    }
    registered.push(key);
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
      log.error(`[serve] request failed: ${String(error)}`);
      return text("internal error\n", 500);
    }
  };
}

/**
 * Has upstream middleware already drained the request body?
 *
 * Node's `req` is a ONE-SHOT stream, so a body parser mounted ahead of this route consumes it and
 * the Request built here has nothing left — a limitation of the Node/Fetch seam itself, shared by
 * every adapter of this kind, not something a different implementation would avoid. What we can
 * avoid is the diagnosis: undici's own answer is `TypeError: Body is unusable`, which names the
 * symptom and neither the cause (something read it first) nor the fix (mount order). For a webhook
 * channel that surfaces as "the integration is broken, and the platform keeps retrying".
 *
 * Deliberately answers only when it is CERTAIN, which means a positive `content-length` and nothing
 * else. `readableEnded` alone is true for any request something upstream merely touched, and a
 * chunked request announces framing rather than content — an empty chunked body is legal, arrives
 * drained, and is indistinguishable from an eaten one. Guessing there would reject a valid request,
 * making this guard the outage it exists to explain; the cost of staying quiet is only that such a
 * request falls back to the adapter's own less helpful error.
 */
function bodyAlreadyRead(req: IncomingMessage): boolean {
  const length = Number(req.headers["content-length"]);
  return Number.isFinite(length) && length > 0 && req.readableEnded;
}

/** The node:http adapter for a Fetch handler — the embedded server uses it, and an embedder mounting
 *  fastagent on its OWN node:http server can too.
 *
 *  Takes the same {@link ChannelHandler} `serveNode` does, so both doors accept the same thing: a
 *  handler may answer synchronously, and `router()` returns exactly that. Requiring a Promise here
 *  made the most natural mount — `nodeListener(router(routes))`, the whole agent on the app's own
 *  server — a type error. */
export function nodeListener(handler: ChannelHandler): (req: IncomingMessage, res: ServerResponse) => void {
  const listener = getRequestListener(totalFetch(handler), { overrideGlobalObjects: false });
  return (req, res) => {
    if (bodyAlreadyRead(req)) {
      log.error(
        `[serve] ${req.method} ${req.url}: the request body was already read by upstream middleware ` +
          `(e.g. express.json()) — mount fastagent BEFORE the body parser, or scope the parser away ` +
          `from this route. Channels that verify webhook signatures need the RAW body.`,
      );
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("internal error\n");
      return;
    }
    listener(req, res);
  };
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
