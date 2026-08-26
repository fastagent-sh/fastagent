/**
 * How a {@link Routes} table becomes a running server: the path rule, dispatch, the totality
 * boundary, and the node:http binding.
 *
 * Shared ground, not a deployment target — every host in `src/deploy/` runs this same process; what
 * differs between them is process, storage, credentials and deployment (core.md §1), none of it
 * here.
 *
 * Dispatch is a Map lookup rather than a router because a deployment mounts a handful of LITERAL
 * paths. A routing library would answer through a pattern language we do not use, and its extra
 * semantics (decode-before-match, HEAD fallback, wildcard precedence) would have to be predicted by
 * every collision check.
 *
 * The types a channel author or an embedder writes stay pure Fetch — SPEC §11 fixes the gateway
 * contract as `(Request) => Response`, and an embedding app may already run its own framework.
 * `overrideGlobalObjects: false` is part of that: the adapter otherwise swaps
 * `globalThis.Request`/`Response` process-wide, which breaks a channel holding a `Response`
 * captured before mount (it fails `instanceof` in {@link totalFetch} and is answered 500).
 *
 * Post-ACK work (a webhook channel's fire-and-forget turns) runs on this event loop and is lost on
 * shutdown — the accepted tradeoff until durable execution (the K axis) exists.
 */
import { serve, getRequestListener } from "@hono/node-server";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { ChannelHandler, Routes } from "../channel.ts";
import { log } from "../log.ts";
import { text } from "./respond.ts";

/** Parse a route key: `"METHOD /path"` → `{ method, path }`, or `"/path"` → `{ path }` (any method).
 *  An empty method (`" /x"`) parses as `""`, which {@link assertRouteKey} refuses — see there. */
export function parseRouteKey(key: string): { method?: string; path: string } {
  const sp = key.indexOf(" ");
  return sp === -1 ? { path: key } : { method: key.slice(0, sp).toUpperCase(), path: key.slice(sp + 1) };
}

/**
 * A route key is `"METHOD /path"` or `"/path"`, with a literal path.
 *
 * Dispatch is a Map lookup, so most of what validation buys is telling an author their handler will
 * not run. Two of the rules are a different judgement: `:id` and `*` ARE reachable literally (a
 * request for `/files/*` carries exactly that path), but nobody writes them meaning that — they
 * write them meaning a pattern, from a framework that has one. Refusing with the reason beats
 * mounting a route that then never matches `/files/a.txt` and leaving them to work out why. The
 * cost is a literal path we will not serve; it is a trade, not a fact.
 *
 * Unusual METHODS are deliberately not on the list, including the ones `fetch` refuses to send.
 * That refusal is a client-side rule: a `TRACE` route is reachable over a raw socket and its
 * handler runs (verified). Rejecting those here would remove a working capability to describe a
 * limitation that lives somewhere else.
 */
export function assertRouteKey(key: string, describe: (problem: string) => string): void {
  const { method, path } = parseRouteKey(key);
  if (method === "") throw new Error(describe('a leading space is not a method — write "/path" for any method'));
  // A method is an HTTP token (RFC 9110). A non-token cannot arrive from any client, unlike the
  // merely unusual ones above. Checked on what the author WROTE: upper-casing first would let `ß`
  // through as `SS`, a token no client can send under the name the key declares.
  const written = key.includes(" ") ? key.slice(0, key.indexOf(" ")) : undefined;
  if (written !== undefined && written !== "" && !/^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/.test(written)) {
    throw new Error(describe(`"${written}" is not a valid HTTP method`));
  }
  if (!path.startsWith("/")) throw new Error(describe('must start with "/"'));
  const pattern = [":", "*"].find((ch) => path.includes(ch));
  if (pattern) {
    throw new Error(describe(`"${pattern}" is not a pattern here — a route key is a literal path, matched exactly`));
  }
  // Asked of `URL` rather than by listing what it rewrites (`?`/`#`, `.`/`..`, `\`, `%2e`). A key it
  // rewrites is unreachable AND compares as a different string, hiding that `/a/../x` and `/x` are
  // one route.
  const arrives = new URL(path, "http://x").pathname;
  if (arrives !== path) {
    throw new Error(describe(`is not the path a request would carry — that request arrives as "${arrives}"`));
  }
}

/** Do these two keys fight over the same request? Equal paths, and a method each answers; a key
 *  with no method answers all of them. */
export function routeKeysConflict(a: string, b: string): boolean {
  const ka = parseRouteKey(a);
  const kb = parseRouteKey(b);
  if (ka.path !== kb.path) return false;
  return ka.method === undefined || kb.method === undefined || ka.method === kb.method;
}

/** A handler owning a path prefix and everything beneath it — the session control plane is the one
 *  user. Kept out of {@link Routes} so a key is always a literal path and collision checks stay
 *  comparisons. */
export interface PrefixMount {
  /** Absolute, no trailing slash, and not `/` (`/control`). Owns `/control` and everything below it.
   *  The root is excluded deliberately: a handler owning every path is that handler, and routing to
   *  it through here would only add a table nothing can reach. */
  prefix: string;
  handler: ChannelHandler;
}

/** Same status and headers, no content (RFC 9110's HEAD). The discarded body is cancelled, or a
 *  streaming producer keeps running with no reader. Shared with the control plane, which answers
 *  HEAD too. */
export function withoutBody(res: Response): Response {
  void res.body?.cancel().catch(() => {});
  return new Response(null, { status: res.status, statusText: res.statusText, headers: res.headers });
}

/** Is `path` inside `prefix`? Segment-wise, so `/controlled` is not inside `/control`. */
export function pathUnderPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Compose a {@link Routes} table and its {@link PrefixMount}s into one handler.
 *
 * Refuses at assembly anything that could not receive a request: a key naming the same route as
 * another (`"/x"` and `"GET /x"`), a route inside a mount, two mounts claiming the same ground. A
 * channel must never go dark unannounced.
 *
 * 404 and 405 stay distinct: a remote client reads 404 as "this serve predates the route" (version
 * skew) rather than as a fault.
 */
export function router(routes: Routes, mounts: readonly PrefixMount[] = []): ChannelHandler {
  for (const [i, mount] of mounts.entries()) {
    assertRouteKey(mount.prefix, (problem) => `mount prefix "${mount.prefix}" is invalid — ${problem}`);
    if (mount.prefix === "/") {
      throw new Error(`mount prefix "/" is invalid — a handler owning every path IS that handler; serve it directly`);
    }
    if (mount.prefix.endsWith("/")) {
      throw new Error(`mount prefix "${mount.prefix}" is invalid — no trailing slash (write "/control")`);
    }
    const clash = mounts
      .slice(0, i)
      .find((other) => pathUnderPrefix(mount.prefix, other.prefix) || pathUnderPrefix(other.prefix, mount.prefix));
    if (clash) {
      throw new Error(`mount "${mount.prefix}" overlaps "${clash.prefix}" — one of them would never receive a request`);
    }
  }
  const byKey = new Map<string, ChannelHandler>();
  const paths = new Set<string>();
  for (const [key, handler] of Object.entries(routes)) {
    assertRouteKey(key, (problem) => `route "${key}" is not a valid route key — ${problem}`);
    const { path } = parseRouteKey(key);
    for (const mount of mounts) {
      if (pathUnderPrefix(path, mount.prefix)) {
        throw new Error(`route "${key}" is inside the mount "${mount.prefix}" — it would never receive a request`);
      }
    }
    const shadowed = [...byKey.keys()].find((other) => routeKeysConflict(other, key));
    if (shadowed) {
      throw new Error(`route "${key}" conflicts with "${shadowed}" — one of them would never receive a request`);
    }
    // Stored normalised: `parseRouteKey` upper-cases the method, so `"get /x"` validates under
    // `GET` and would otherwise be looked up under a name nothing stores.
    const { method } = parseRouteKey(key);
    byKey.set(method ? `${method} ${path}` : path, handler);
    paths.add(path);
  }

  return (req) => {
    // `URL` normalises the path (`/a/../x` → `/x`) and drops query/fragment.
    const path = new URL(req.url).pathname;
    // HEAD carries no content (RFC 9110) whichever route answers it — a mount, an explicit `HEAD`
    // route, a method-less one, or the `GET` fallback. Dropped here, not left to the HTTP layer:
    // this handler is public surface and a direct caller must see the same answer as the socket.
    const head = req.method === "HEAD";
    const strip = (r: Response | Promise<Response>) => (r instanceof Promise ? r.then(withoutBody) : withoutBody(r));
    for (const mount of mounts) {
      if (pathUnderPrefix(path, mount.prefix)) return head ? strip(mount.handler(req)) : mount.handler(req);
    }
    const exact = byKey.get(`${req.method} ${path}`) ?? byKey.get(path);
    if (exact) return head ? strip(exact(req)) : exact(req);
    if (head) {
      const get = byKey.get(`GET ${path}`);
      if (get) return strip(get(req));
    }
    return paths.has(path) ? text("method not allowed\n", 405) : text("not found\n", 404);
  };
}

/**
 * The totality boundary every serving path shares. `loadChannels` imports arbitrary author code, so
 * a channel that throws — or forgets to return — must become a logged 500 rather than escape as an
 * unhandled rejection. Both `nodeListener` and `serveNode` route through it.
 *
 * The message stays internal: an adapter's default error page would echo exception text (a stack, a
 * path, a key inside an error string) to whoever made the request. Visibility is the LOG's job.
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
 * Node's `req` is one-shot, so a body parser mounted ahead of this route consumes it — a property of
 * the Node/Fetch seam, not of this adapter. What is avoidable is the diagnosis: undici answers
 * `TypeError: Body is unusable`, naming neither the cause nor the fix, and for a webhook channel
 * that reads as "the integration is broken and the platform keeps retrying".
 *
 * Answers only when CERTAIN — a positive `content-length`. `readableEnded` alone is true for any
 * request something upstream merely touched, and an empty chunked body is legal, arrives drained,
 * and is indistinguishable from an eaten one. Guessing there rejects valid requests, making this
 * guard the outage it explains.
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
