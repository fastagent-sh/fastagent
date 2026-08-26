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
 * Dispatch is a Map lookup, not a router. A deployment mounts a handful of LITERAL paths — one per
 * channel, plus health, plus the control plane's prefix — and for literal paths "which handler
 * serves this request?" is `map.get(pathname)`. A routing library would answer the same question
 * through a pattern language we do not use, and its extra semantics (decode-before-match, HEAD
 * fallback, wildcard precedence) would then have to be PREDICTED by every collision check. That
 * prediction is what drifted, repeatedly. Here the behaviour is the twelve lines below.
 *
 * The types a channel author or an embedder writes stay pure Fetch (`ChannelHandler`, `Routes` in
 * `../channel.ts`) — SPEC §11 fixes the gateway contract as `(Request) => Response`, an agent
 * directory ships hand-written modules with that signature, and an app embedding fastagent may
 * already run Express/Fastify. What we must not do is pick their framework for them.
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
 * A route key is `"METHOD /path"` or `"/path"`, and the path is a literal one.
 *
 * The list is short because dispatch is a Map lookup: an unmatched key is simply never found, so
 * the only thing validation buys is telling an author their handler will not run. These are the
 * spellings someone plausibly writes believing they work — patterns from other frameworks, and a
 * URL where a path belongs. Everything else (`.`/`..`, backslashes, exotic methods) is left alone:
 * it is not reachable either, but nobody writes it by accident, and a rule that never fires is a
 * rule the next reader has to understand for nothing.
 */
export function assertRouteKey(key: string, describe: (problem: string) => string): void {
  const { method, path } = parseRouteKey(key);
  if (method === "") throw new Error(describe('a leading space is not a method — write "/path" for any method'));
  if (!path.startsWith("/")) throw new Error(describe('must start with "/"'));
  const pattern = [":", "*"].find((ch) => path.includes(ch));
  if (pattern) {
    throw new Error(describe(`"${pattern}" is not a pattern here — a route key is a literal path`));
  }
  // Asked of `URL`, which is the authority on what a request's path becomes, rather than by listing
  // the spellings it rewrites (`?`/`#`, `.`/`..`, backslashes, `%2e`). A key it rewrites can never
  // be matched — the request arrives under the rewritten path — and worse, it compares as a
  // different string, so the conflict check would not notice `/a/../x` and `/x` are one route.
  const arrives = new URL(path, "http://x").pathname;
  if (arrives !== path) {
    throw new Error(describe(`is not the path a request would carry — that request arrives as "${arrives}"`));
  }
}

/**
 * Do these two keys fight over the same request? With literal paths this is a comparison, not a
 * prediction: equal paths, and a method each answers. A key with no method answers all of them.
 */
export function routeKeysConflict(a: string, b: string): boolean {
  const ka = parseRouteKey(a);
  const kb = parseRouteKey(b);
  if (ka.path !== kb.path) return false;
  return ka.method === undefined || kb.method === undefined || ka.method === kb.method;
}

/** A handler owning a path prefix and everything beneath it — the session control plane is the one
 *  user. Kept OUT of {@link Routes}: mixing "a literal path" and "a prefix I own" in one dictionary
 *  is what forced every collision check to parse keys and predict the matcher's behaviour. */
export interface PrefixMount {
  /** Absolute, no trailing slash (`/control`). Owns `/control` and everything below it. */
  prefix: string;
  handler: ChannelHandler;
}

/** Same status and headers, no content (RFC 9110's HEAD) — and the discarded body is cancelled
 *  rather than left to its producer, which for a streaming handler would keep running with no
 *  reader. Exported because the control plane answers HEAD too, and one semantics needs one
 *  implementation: the first copy of this dropped every header. */
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
 * Refuses, at assembly, anything that could not receive a request: a key naming the same route as
 * another (`"/x"` and `"GET /x"`), a route inside a mount, or two mounts claiming the same ground.
 * That check is the reason the path language is literal — with literal paths it is a comparison of
 * keys, not a prediction about a matcher, and a channel can never go dark unannounced.
 *
 * 404 and 405 stay distinct: a remote client reads 404 as "this serve predates the route" (version
 * skew) rather than as a fault.
 */
export function router(routes: Routes, mounts: readonly PrefixMount[] = []): ChannelHandler {
  for (const [i, mount] of mounts.entries()) {
    assertRouteKey(mount.prefix, (problem) => `mount prefix "${mount.prefix}" is invalid — ${problem}`);
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
    // Stored NORMALISED, not as written: `parseRouteKey` upper-cases the method, so a `"get /x"`
    // key passes validation and conflict-checking under `GET` and would then be looked up under a
    // name nothing stores. Lower-case is a reasonable thing to write; it just has one meaning.
    const { method } = parseRouteKey(key);
    byKey.set(method ? `${method} ${path}` : path, handler);
    paths.add(path);
  }

  return (req) => {
    // `URL` gives the path already normalised (`/a/../x` → `/x`) and free of query/fragment, which
    // is why neither needs a rule of its own above.
    const path = new URL(req.url).pathname;
    for (const mount of mounts) if (pathUnderPrefix(path, mount.prefix)) return mount.handler(req);
    const exact = byKey.get(`${req.method} ${path}`) ?? byKey.get(path);
    if (exact) return exact(req);
    // HEAD is GET without the content (RFC 9110) — served from the GET route when the author did
    // not write an explicit one. The body is dropped HERE rather than left to the HTTP layer: this
    // handler is public surface, and a caller invoking it directly must see the same answer.
    if (req.method === "HEAD") {
      const get = byKey.get(`GET ${path}`);
      if (get) {
        const answer = get(req);
        return answer instanceof Promise ? answer.then(withoutBody) : withoutBody(answer);
      }
    }
    return paths.has(path) ? text("method not allowed\n", 405) : text("not found\n", 404);
  };
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
