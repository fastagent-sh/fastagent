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

/** Parse a route key: `"METHOD /path"` → `{ method, path }`, or `"/path"` → `{ path }` (any method).
 *  An empty method (`" /x"`) parses as `""`, which {@link assertRouteKey} refuses — see there. */
export function parseRouteKey(key: string): { method?: string; path: string } {
  const sp = key.indexOf(" ");
  return sp === -1 ? { path: key } : { method: key.slice(0, sp).toUpperCase(), path: key.slice(sp + 1) };
}

/**
 * The path language a {@link Routes} key speaks: a LITERAL path. Nothing else.
 *
 * Narrower than the matcher underneath on purpose. Two channels must never silently shadow each
 * other, so "would these two routes fight over a request?" has to be answerable — and for literal
 * paths the answer is string equality, a fact about the keys rather than a prediction about the
 * matcher. Every pattern admitted here would have to be predicted instead, by this check and by
 * every other one, which is a model that drifts from the thing it models. Prefix mounting lives in
 * {@link PrefixMount}, outside the key language, for exactly that reason.
 */
export function assertRouteKey(key: string, describe: (problem: string) => string): void {
  const { method, path } = parseRouteKey(key);
  // `" /x"` — a leading space — is a third spelling the contract does not define, and normalising it
  // to "any method" would define it here instead, in one reader's head. Refused: an author who wrote
  // it meant `"/x"`, and the ONE thing worse than an unsupported spelling is a supported one nobody
  // documented.
  if (method === "") throw new Error(describe('a leading space is not a method — write "/path" for any method'));
  // "ALL" is the matcher's own word for any-method, which we already spell `"/path"`. Two spellings
  // for one meaning is what the leading-space case above was; keep one.
  if (method === "ALL") throw new Error(describe('write "/path" for any method, not "ALL /path"'));
  // A method is an HTTP token (RFC 9110), and not one the Fetch standard forbids — `fetch` refuses
  // to construct a request with CONNECT/TRACE/TRACK, so those routes could only sit unreachable.
  // Same test as HEAD, applied to the other end: can a request bearing this method ever arrive?
  if (method !== undefined && !/^[A-Z0-9!#$%&'*+\-.^_`|~]+$/.test(method)) {
    throw new Error(describe(`"${method}" is not a valid HTTP method`));
  }
  if (method !== undefined && ["CONNECT", "TRACE", "TRACK"].includes(method)) {
    throw new Error(describe(`"${method}" is forbidden by the Fetch standard — no request can carry it`));
  }
  // HEAD is not a method you can route here: the matcher answers HEAD from the GET route (RFC 9110)
  // and never reaches an explicitly registered HEAD handler — verified in both registration orders,
  // and a HEAD-only route 404s outright. Refusing it says so at mount instead of leaving an author
  // with a handler that silently never runs.
  if (method === "HEAD") {
    throw new Error(describe("HEAD is served by the GET route (RFC 9110); an explicit HEAD route never runs"));
  }
  assertLiteralPath(path, describe);
}

/**
 * The path rule, shared by route keys and {@link PrefixMount} prefixes — they are the same kind of
 * thing, and a prefix that was never checked would let the matcher resolve `/files/:id` its own way
 * while {@link pathUnderPrefix} compared it as a literal string, which is precisely the split this
 * whole language exists to close.
 */
function assertLiteralPath(path: string, describe: (problem: string) => string): void {
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
  // Everything above is one rule wearing four hats: a route key is a LITERAL path. Patterns (`:id`,
  // `*`) are refused not because they are hard to support — the matcher underneath does support
  // them — but because supporting them means predicting how it resolves them, and every collision
  // check would have to predict the same way. A literal path collides with another when the strings
  // are equal, which is a fact rather than a model. Prefix mounting still exists; it is a separate
  // argument to `router` (see PrefixMount), not a spelling of a route key.
  const pattern = [":", "*"].find((ch) => path.includes(ch));
  if (pattern) {
    throw new Error(describe(`"${pattern}" is not allowed — this must be a literal path`));
  }
  // Anything a URL normalises away is the percent-encoding problem in another spelling: the request
  // arrives under the normalised path, so the route is unreachable, AND the two spellings compare as
  // different strings, so it slips past every conflict check. `/a/../x` is the sharp one — it is a
  // second, invisible way to write `/x`. (Verified: it never receives a request, and `/x` gets them.)
  if (path.includes("\\")) throw new Error(describe('"\\" is not allowed — a path separator is "/"'));
  const dotSegment = path.split("/").find((seg) => seg === "." || seg === "..");
  if (dotSegment !== undefined) {
    throw new Error(describe(`"${dotSegment}" segments are not allowed — write the path they resolve to`));
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

/** Is `path` inside `prefix`? Segment-wise, so `/controlled` is not inside `/control`. */
export function pathUnderPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
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
export function router(routes: Routes, mounts: readonly PrefixMount[] = []): ChannelHandler {
  const app = new Hono();
  // Mounts against each other, by the same rule they apply to routes: `/control` and
  // `/control/admin` both claim `/control/admin/*`, and registration order would pick a winner in
  // silence. "Owns everything beneath it" has to mean the same thing in every direction.
  for (const [i, mount] of mounts.entries()) {
    assertLiteralPath(mount.prefix, (problem) => `mount prefix "${mount.prefix}" is invalid — ${problem}`);
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
  const paths: string[] = [];
  const registered: string[] = [];
  for (const [key, handler] of Object.entries(routes)) {
    const { method, path } = parseRouteKey(key);
    // Enforced HERE, not only where channel files are loaded: an embedder passing `Routes` directly
    // is the other door in, and both must admit the same language.
    assertRouteKey(key, (problem) => `route "${key}" is not a valid route key — ${problem}`);
    for (const mount of mounts) {
      if (pathUnderPrefix(path, mount.prefix)) {
        throw new Error(`route "${key}" is inside the mount "${mount.prefix}/*" — it would never receive a request`);
      }
    }
    // Two keys can differ and still name the same route (`"/x"` and `"GET /x"`); the object's own
    // key uniqueness does not catch that, and registration order would silently pick a winner.
    const shadowed = registered.find((other) => routeKeysConflict(other, key));
    if (shadowed) {
      throw new Error(`route "${key}" conflicts with "${shadowed}" — one of them would never receive a request`);
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
  // Mounts last: a mount owns everything under its prefix, including paths it does not serve, so it
  // must not intercept a literal route — the loop above already refused any that would collide.
  for (const mount of mounts) app.all(`${mount.prefix}/*`, (c) => mount.handler(c.req.raw));
  for (const mount of mounts) app.all(mount.prefix, (c) => mount.handler(c.req.raw));
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
