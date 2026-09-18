/**
 * How a {@link Routes} table becomes a running server: the path rule, dispatch, WHO MAY CALL IT FROM A BROWSER, the
 * totality boundary, and the node:http binding.
 */
import { serve, getRequestListener } from "@hono/node-server";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { classifyBind } from "../bind.ts";
import type { ChannelHandler, Routes } from "../channel.ts";
import { log } from "../log.ts";
import { text } from "./respond.ts";

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
 * THE cross-origin policy, in one place, for the routes fastagent OWNS.
 *
 * Default: a browser on the serving machine only. Everything this port serves is UNAUTHENTICATED (design
 * §14), so a wildcard would hand every page the developer visits a working client for `POST /invoke` (a turn with
 * the agent's full tool authority) and `/control/*` (read every conversation, delete a session) — the loopback bind
 * that is supposed to be the boundary does not stop a cross-origin request, only a same-machine one. This is Vite's
 * CVE-2025-24010 with tool authority behind it, and its fix is the shape copied here: loopback origins by default,
 * real origins named explicitly.
 *
 * `allow` is exact-match origins from `http.cors`; `"*"` in that list restores the wildcard for a deployment that
 * has decided the port is safely fronted.
 *
 * The SERVE'S OWN host is always allowed: a browser sends `Origin` on same-origin writes too, so a web UI shipped
 * from the deployment it talks to would otherwise be refused by the rule meant for third-party pages. Compared by
 * hostname rather than whole origin because a TLS-terminating gateway rewrites scheme and port, and neither is a
 * thing an attacking page can choose — the host is whatever the victim's browser dialled.
 */
function allowedOrigin(origin: string, allow: readonly string[], self: string): string | undefined {
  if (allow.includes("*")) return "*";
  if (allow.includes(origin)) return origin;
  if (isLoopbackOrigin(origin)) return origin;
  try {
    return new URL(origin).hostname === self ? origin : undefined;
  } catch {
    // Not a URL (`null`, a bare hostname): no origin a browser could have produced, so nothing to allow.
    return undefined;
  }
}

export interface RouterOptions {
  /**
   * Paths fastagent OWNS, which are therefore browser-callable: they answer CORS preflights and carry CORS headers.
   * A channel's route is never in here — its caller is a platform's server, and a webhook that answers cross-origin
   * requests is one a page can drive. Mounted prefixes are always owned (the control plane is the only mount).
   */
  browserPaths?: readonly string[];
  /** Extra origins beyond loopback, from `http.cors`. `["*"]` is the wildcard, and is a deployment's decision. */
  corsOrigins?: readonly string[];
}

/** Compose a {@link Routes} table and its {@link PrefixMount}s into one handler. */
export function router(
  routes: Routes,
  mounts: readonly PrefixMount[] = [],
  options: RouterOptions = {},
): ChannelHandler {
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
    // Stored normalised: `parseRouteKey` upper-cases the method, so `"get /x"` validates under `GET` and would
    // otherwise be looked up under a name nothing stores.
    const { method } = parseRouteKey(key);
    byKey.set(method ? `${method} ${path}` : path, handler);
    paths.add(path);
  }

  const browserPaths = new Set(options.browserPaths ?? []);
  const corsOrigins = options.corsOrigins ?? [];
  /** Ours to publish to a browser? Every mount is (the control plane), plus the paths the caller named. */
  const ownedByUs = (path: string): boolean =>
    browserPaths.has(path) || mounts.some((mount) => pathUnderPrefix(path, mount.prefix));

  return (req) => {
    // `URL` normalises the path (`/a/../x` → `/x`) and drops query/fragment.
    const self = new URL(req.url);
    const path = self.pathname;
    const origin = req.headers.get("origin");
    // A BROWSER request against a path we publish. A non-browser client sends no `Origin` and is untouched by any
    // of this.
    const fromPage = origin !== null && ownedByUs(path);
    // Decided BEFORE dispatch, so a 404, a 405 and a handler's own reply all leave with the same verdict — a browser
    // that cannot read the 405 gets an opaque network error instead of the reason.
    const cors = fromPage ? allowedOrigin(origin as string, corsOrigins, self.hostname) : undefined;
    const answer = (): Response | Promise<Response> => {
      // REFUSED, not merely denied the reply. Withholding the headers only stops the page from READING the answer,
      // and a simple request (`content-type: text/plain`, which neither invoke nor the control plane rejects) skips
      // the preflight entirely — so the side effect it asked for, a turn with this agent's tools, would already have
      // happened. Vite's fix for the same shape refuses too.
      if (fromPage && cors === undefined) return text("forbidden origin\n", 403);
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
      if (ownedByUs(path)) out.headers.append("vary", "origin");
      if (cors === undefined) return out;
      out.headers.set("access-control-allow-origin", cors);
      out.headers.set("access-control-allow-headers", "authorization, content-type");
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
