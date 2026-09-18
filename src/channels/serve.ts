/**
 * How a {@link Routes} table becomes a running server: the path rule, dispatch, WHO MAY CALL IT FROM A BROWSER, the
 * totality boundary, and the node:http binding.
 */
import { serve, getRequestListener } from "@hono/node-server";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { classifyBind } from "../bind.ts";
import type { ChannelHandler, Routes } from "../channel.ts";
import { log } from "../log.ts";
import { refuseNonJsonBody } from "./body.ts";
import { text } from "./respond.ts";

/** Methods whose request carries a body a handler will parse — what the JSON gate applies to. */
const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

/** Parse a route key: `"METHOD /path"` → `{ method, path }`, or `"/path"` → `{ path }` (any method). */
export function parseRouteKey(key: string): { method?: string; path: string } {
  const sp = key.indexOf(" ");
  return sp === -1 ? { path: key } : { method: key.slice(0, sp).toUpperCase(), path: key.slice(sp + 1) };
}

/** A route key is `"METHOD /path"` or `"/path"`, with a literal path. */
export function assertRouteKey(key: string, describe: (problem: string) => string): void {
  const { method, path } = parseRouteKey(key);
  if (method === "") throw new Error(describe('a leading space is not a method — write "/path" for any method'));
  if (!path.startsWith("/")) throw new Error(describe('must start with "/"'));
  // Asked of `URL` rather than by listing what it rewrites (`?`/`#`, `.`/`..`, `\`, `%2e`).
  const arrives = new URL(path, "http://x").pathname;
  if (arrives !== path) {
    throw new Error(describe(`is not the path a request would carry — that request arrives as "${arrives}"`));
  }
}

/** Do these two keys fight over the same request? */
export function routeKeysConflict(a: string, b: string): boolean {
  const ka = parseRouteKey(a);
  const kb = parseRouteKey(b);
  if (ka.path !== kb.path) return false;
  return ka.method === undefined || kb.method === undefined || ka.method === kb.method;
}

/** A handler owning a path prefix and everything beneath it — the session control plane is the one user. */
export interface PrefixMount {
  /** Absolute, no trailing slash, and not `/` (`/control`). */
  prefix: string;
  handler: ChannelHandler;
}

/** Same status and headers, no content (RFC 9110's HEAD). */
export function withoutBody(res: Response): Response {
  void res.body?.cancel().catch(() => {});
  return new Response(null, { status: res.status, statusText: res.statusText, headers: res.headers });
}

export function pathUnderPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Is this `Origin` a browser running on the SERVING machine?
 *
 * The same loopback vocabulary the bind uses ({@link classifyBind}), asked of an origin's host — so "what counts as
 * this machine" has one definition, not one per question.
 */
function isLoopbackOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    // Not a URL at all (`null`, a bare hostname): no origin a browser could have produced.
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return classifyBind(url.hostname) === "loopback";
}

/**
 * THE cross-origin policy, in one place, for the routes that authenticate nobody.
 *
 * THIS IS AN API, so the default is an API's: `*`. Origin is not access control — what makes a normal API safe to
 * call from any page is that it demands a credential the page does not have, which makes the caller's origin
 * irrelevant. We have no credential, so once the port is PUBLISHED the question becomes which network it is on and
 * what sits in front of it — the operator's decision, made with information this process does not have. On a public
 * host `*` adds nothing an attacker could not already curl; on a LAN or VPC host it adds the victim's network
 * position, which is why the docs state the grant plainly rather than calling the default safe.
 *
 * The ONE exception is a port whose only reachability is the developer's own browser — an unpublished loopback
 * serve. There the attacker cannot reach the port at all, so answering their page IS the whole attack path. Note
 * what this is and is not: the browser already denies a cross-origin read by default, so we are not adding a lock,
 * we are declining to REMOVE one on behalf of a port that has nothing else protecting it. Vite shipped the wildcard
 * in this exact posture and it became CVE-2025-24010, over source code rather than tool authority; its fix and
 * Ollama's default are both this shape.
 *
 * `allow` is `http.cors`, and when it is set it REPLACES the default rather than adding to it — one value, one
 * meaning, in both directions: a front end calling an unpublished dev serve widens, a deployment pinning one origin
 * instead of `*` narrows. A dev serve that also wants its own loopback page back lists it.
 *
 * A page that is not allowed is simply not ANSWERED — no headers, no refusal. That is safe only because a route
 * that authenticates nobody also refuses a body that is not `application/json` (channels/body.ts): without that, a
 * cross-origin `text/plain` POST is a CORS simple request, sent with no preflight, and withholding the headers
 * would only stop the page from reading a turn that had already run.
 */
function allowedOrigin(origin: string, allow: readonly string[], published: boolean): string | undefined {
  if (allow.length > 0) return allow.includes("*") ? "*" : allow.includes(origin) ? origin : undefined;
  if (published) return "*";
  return isLoopbackOrigin(origin) ? origin : undefined;
}

/**
 * Refuse a cross-origin allow-list that cannot match anything.
 *
 * ONE check for BOTH ways in: `http.cors` in a config file, and `corsOrigins` handed to `mountAgentService` by an
 * embedder. `allowedOrigin` compares exact strings, so `"https://app.example.com/"` — one trailing slash — never
 * matches and the front end is refused with nothing pointing at the rule. A rule that silently matches nothing is
 * worse than one that refuses to load.
 */
export function assertCorsOrigins(origins: unknown, where: string): asserts origins is string[] {
  if (!Array.isArray(origins) || origins.some((o) => typeof o !== "string" || o === "")) {
    throw new Error(`${where} must be an array of origin strings (e.g. ["https://app.example.com"])`);
  }
  for (const origin of origins as string[]) {
    if (origin === "*") continue;
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      // `new URL` throwing IS the answer here ("not a URL at all"); rethrown as the rule that cannot load.
      throw new Error(`${where} entry ${JSON.stringify(origin)} is not an origin ("https://host[:port]")`);
    }
    // An ORIGIN, not a URL with a path: `new URL(...).origin` is what a browser sends.
    if (parsed.origin !== origin) {
      throw new Error(
        `${where} entry ${JSON.stringify(origin)} is not the origin a browser sends — use ${JSON.stringify(parsed.origin)}`,
      );
    }
  }
}

/**
 * The tables a router composes, NAMED rather than ordered.
 *
 * Two same-typed positional arguments encoded which side of the trust axis a table was on, and getting them the
 * wrong way round type-checked: the AgentCore adapter passed its IAM-gated routes as `unverified` and they were
 * reported as unauthenticated for two commits. A caller now spells the axis at the call site.
 */
export interface RouterSurface {
  /** Routes that authenticate NOBODY — the router applies the JSON body gate and the cross-origin policy to them. */
  unverified?: Routes;
  /** Routes that verify their own caller (a channel's platform signature, a host's IAM). Neither guard applies. */
  selfVerifying?: Routes;
  /** Prefix-owning handlers. Always treated as unverified — the control plane is the only one. */
  mounts?: readonly PrefixMount[];
}

export interface RouterOptions {
  /** `http.cors` — exact origins, or `["*"]`. Widens an unpublished serve, narrows a published one. */
  corsOrigins?: readonly string[];
  /**
   * Is this port reachable by anyone but the developer's own browser? A wildcard/LAN bind, or a tunnel over a
   * loopback one. It decides the cross-origin default and nothing else — see {@link allowedOrigin}. Unset is the
   * conservative reading, which is what an embedder gets: they own the mounting, so widening is theirs to say.
   */
  published?: boolean;
}

/**
 * Compose the routes that AUTHENTICATE NOBODY, the self-verifying channel routes, and the {@link PrefixMount}s
 * into one handler.
 *
 * That is the axis, not authorship. Two things follow from it and nothing else does: whether a browser may drive
 * the route, and whether its body must declare JSON. A channel route is exempt from both because it checks its
 * platform's signature inside itself — a Telegram webhook is public on purpose. Ours check nothing, so the router
 * checks for them.
 *
 * TWO TABLES, not one table plus a list of which keys are which. While it was a parallel array, three readers each
 * had their own chance to answer differently, and two of them did: a channel serving `/invoke` was announced as
 * our data plane, and the same fact was hand-written as `[]` in one place while derived in another.
 *
 * CAVEAT, stated because we cannot enforce it: a CUSTOM channel that verifies nothing lands in `selfVerifying`
 * anyway and gets neither guard. That is decision B (docs/design/session-control.md §14) and it belongs to the
 * channel's author, who owns the credential the platform issued — but it is an assumption here, not a property.
 */
export function router(surface: RouterSurface, options: RouterOptions = {}): ChannelHandler {
  const { unverified = {}, selfVerifying = {}, mounts = [] } = surface;
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
  const unguarded = new Set<string>();
  for (const [key, handler] of [...Object.entries(unverified), ...Object.entries(selfVerifying)]) {
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
    // Stored normalised: `parseRouteKey` upper-cases the method, so `"get /x"` validates under `GET` and would
    // otherwise be looked up under a name nothing stores.
    const { method } = parseRouteKey(key);
    const normalised = method ? `${method} ${path}` : path;
    byKey.set(normalised, handler);
    paths.add(path);
    if (key in unverified) unguarded.add(normalised);
  }

  const corsOrigins = options.corsOrigins ?? [];
  const published = options.published === true;
  /** Does this route authenticate nobody? Every mount does (the control plane), plus what we registered ourselves. */
  const authenticatesNobody = (method: string, path: string): boolean =>
    mounts.some((mount) => pathUnderPrefix(path, mount.prefix)) ||
    unguarded.has(`${method} ${path}`) ||
    unguarded.has(path) ||
    // The router answers HEAD from a GET route, so the question follows it.
    (method === "HEAD" && unguarded.has(`GET ${path}`));

  return (req) => {
    // `URL` normalises the path (`/a/../x` → `/x`) and drops query/fragment.
    const path = new URL(req.url).pathname;
    const origin = req.headers.get("origin");
    // A preflight asks ABOUT a method; ownership is that method's, not `OPTIONS`'s (nothing registers OPTIONS).
    const asking =
      req.method === "OPTIONS"
        ? (req.headers.get("access-control-request-method")?.toUpperCase() ?? "OPTIONS")
        : req.method;
    // A BROWSER request against a route that authenticates nobody. A non-browser client sends no `Origin` and is
    // untouched by any of this.
    const owned = authenticatesNobody(asking, path);
    const fromPage = origin !== null && owned;
    // Decided BEFORE dispatch, so a 404, a 405 and a handler's own reply all leave with the same verdict — a browser
    // that cannot read the 405 gets an opaque network error instead of the reason.
    const cors = fromPage ? allowedOrigin(origin as string, corsOrigins, published) : undefined;
    const answer = (): Response | Promise<Response> => {
      // The gate that makes "an origin we do not allow is simply not answered" safe: a POST carrying `text/plain`
      // is a CORS simple request, sent with no preflight at all, so a route that authenticates nobody must refuse
      // the body itself. HERE, over the whole unguarded surface, rather than inside each handler — the next route
      // we add is covered by existing. A self-verifying channel is exempt: Slack posts urlencoded, and a page
      // cannot forge its signature anyway.
      if (owned && BODY_METHODS.has(req.method)) {
        const wrongType = refuseNonJsonBody(req);
        if (wrongType) return wrongType;
      }
      // The preflight is the ROUTER's to answer: it names a method the route table does not register, so leaving it
      // to the routes below is a 405 with no CORS headers, which is a browser client that cannot call a route that
      // works.
      if (req.method === "OPTIONS" && cors !== undefined) return new Response(null, { status: 204 });
      for (const mount of mounts) if (pathUnderPrefix(path, mount.prefix)) return mount.handler(req);
      const exact = byKey.get(`${req.method} ${path}`) ?? byKey.get(path);
      if (exact) return exact(req);
      if (req.method === "HEAD") {
        const get = byKey.get(`GET ${path}`);
        if (get) return get(req);
      }
      return paths.has(path) ? text("method not allowed\n", 405) : text("not found\n", 404);
    };
    /**
     * ONE exit, so the HEAD rule and the CORS verdict hold for every reply — a mount's, a route's, the GET
     * fallback's, and the 404/405 this router writes itself.
     */
    const finish = (res: Response): Response => {
      const out = req.method === "HEAD" ? withoutBody(res) : res;
      // `vary` whether or not the origin was allowed: the answer DEPENDS on the request's origin either way, and a
      // cache that does not know it would serve one caller's verdict to another.
      if (owned) out.headers.append("vary", "origin");
      if (cors === undefined) return out;
      out.headers.set("access-control-allow-origin", cors);
      // Echoed for the same reason the methods are: what a caller needs is not ours to enumerate. A gateway in front
      // of this port demands its own header (`connectSessionControl({ fetchFn })` is how a client sends one), and a
      // fixed list turns that preflight into a 204 the browser then refuses to act on. The default names the two a
      // client of ours always needs, for a preflight that asked about nothing.
      out.headers.set(
        "access-control-allow-headers",
        req.headers.get("access-control-request-headers") ?? "authorization, content-type",
      );
      // The method the preflight ASKED about, not a table lookup: a mount owns a prefix and does not publish which
      // methods each path under it serves. Naming one the path does not serve costs nothing now that the 405 it
      // produces carries these same headers.
      const asked = req.headers.get("access-control-request-method")?.toUpperCase();
      out.headers.set("access-control-allow-methods", [...new Set([asked, "OPTIONS"].filter(Boolean))].join(", "));
      return out;
    };
    const res = answer();
    return res instanceof Promise ? res.then(finish) : finish(res);
  };
}

/** The totality boundary every serving path shares. */
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

/** Has upstream middleware already drained the request body? */
function bodyAlreadyRead(req: IncomingMessage): boolean {
  const length = Number(req.headers["content-length"]);
  return Number.isFinite(length) && length > 0 && req.readableEnded;
}

/**
 * The node:http adapter for a Fetch handler — the embedded server uses it, and an embedder mounting fastagent on its
 * OWN node:http server can too.
 */
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
  // serve() types its return as the union of every server it CAN build (incl. http2).
  const server = serve(
    {
      fetch: totalFetch(handler),
      overrideGlobalObjects: false,
      port: options.port,
      ...(options.host !== undefined ? { hostname: options.host } : {}),
    },
    (info) => {
      // Detach before resolving: this listener answers the BIND, and leaving it attached would let a later runtime
      // error call reject() on a settled promise.
      server.off("error", onBindError);
      onListening(info.port);
    },
  ) as Server;
  server.once("error", onBindError); // a bind failure surfaces here, before "listening"
  const close = () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  const closeAllConnections = (): void => server.closeAllConnections();
  return { listening, close, closeAllConnections };
}
