/**
 * How a {@link Routes} table becomes a running server: the path rule, dispatch, the totality boundary, and the
 * node:http binding.
 */
import { serve, getRequestListener } from "@hono/node-server";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
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

/** Compose a {@link Routes} table and its {@link PrefixMount}s into one handler. */
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
    // Stored normalised: `parseRouteKey` upper-cases the method, so `"get /x"` validates under `GET` and would
    // otherwise be looked up under a name nothing stores.
    const { method } = parseRouteKey(key);
    byKey.set(method ? `${method} ${path}` : path, handler);
    paths.add(path);
  }

  return (req) => {
    // `URL` normalises the path (`/a/../x` → `/x`) and drops query/fragment.
    const path = new URL(req.url).pathname;
    const answer = (): Response | Promise<Response> => {
      for (const mount of mounts) if (pathUnderPrefix(path, mount.prefix)) return mount.handler(req);
      const exact = byKey.get(`${req.method} ${path}`) ?? byKey.get(path);
      if (exact) return exact(req);
      if (req.method === "HEAD") {
        const get = byKey.get(`GET ${path}`);
        if (get) return get(req);
      }
      return paths.has(path) ? text("method not allowed\n", 405) : text("not found\n", 404);
    };
    // ONE exit, so the HEAD rule holds for every reply — a mount's, a route's, the GET fallback's, and the 404/405
    // this router writes itself.
    const res = answer();
    if (req.method !== "HEAD") return res;
    return res instanceof Promise ? res.then(withoutBody) : withoutBody(res);
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
