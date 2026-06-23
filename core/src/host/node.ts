/**
 * The Node host (a K-axis target adapter): run channels on a long-running Node process.
 *
 * Channels (N-axis) stay platform-agnostic — they produce a {@link HostResult} (a Response, plus any
 * post-ACK `background` work that must outlive the response). The host is the only layer that knows
 * the platform: it serves the routes, keeps `background` alive IN-PROCESS (the process stays up), and
 * drains outstanding work on shutdown. A different target (serverless) satisfies the same HostResult
 * differently (`ctx.waitUntil(background)`); the channel is unchanged.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { nodeListener } from "../channels/http.ts";

/** What a mounted handler returns: a Response, or a Response plus post-ACK work for the host to keep alive. */
export type HostResult = Response | { response: Response; background?: Promise<unknown> };

/** A mounted request handler (a channel's `fetch`, or a plain route like health). */
export type ChannelHandler = (req: Request) => HostResult | Promise<HostResult>;

/** This deployment's HTTP surface: route key → handler. Key is `"/path"` or `"METHOD /path"`. */
export type Routes = Record<string, ChannelHandler>;

const textHeaders = { "content-type": "text/plain" };

/** Parse a route key: `"METHOD /path"` → `{ method, path }`, or `"/path"` → `{ path }` (any method). */
function parseRouteKey(key: string): { method?: string; path: string } {
  const sp = key.indexOf(" ");
  return sp === -1 ? { path: key } : { method: key.slice(0, sp).toUpperCase(), path: key.slice(sp + 1) };
}

/**
 * Is `path` exactly a pathname `router` could match? router compares stored paths to
 * `new URL(req.url).pathname`, so a valid path must equal what URL parsing yields for it — leading
 * "/", no whitespace/encoded chars, no query/fragment. Validating against the REAL matching semantics
 * is complete by construction, unlike a blocklist of known-bad formats.
 */
function isMatchablePath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  try {
    const u = new URL(path, "http://h");
    return u.pathname === path && u.search === "" && u.hash === "";
  } catch {
    return false;
  }
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
    if (onPath.length === 0) return new Response("not found\n", { status: 404, headers: textHeaders });
    const match = onPath.find((e) => e.method === undefined || e.method === req.method);
    if (!match) return new Response("method not allowed\n", { status: 405, headers: textHeaders });
    return match.handler(req);
  };
}

/**
 * Validate a channels-factory result before serving (fail visibly, not a silent empty server). The
 * factory is meant to be synchronous: an `async channels` returns a Promise, which `router` would see
 * as zero routes; a non-object or a non-function route value would 404/500 obscurely later.
 */
export function assertRoutes(routes: unknown): Routes {
  if (typeof (routes as { then?: unknown })?.then === "function") {
    throw new Error(
      "`channels` must be synchronous and return a Routes object, but it returned a Promise \u2014 do any async setup at the config module's top level, then return the routes synchronously",
    );
  }
  if (routes === null || typeof routes !== "object") {
    throw new Error(`\`channels\` must return a Routes object (got ${routes === null ? "null" : typeof routes})`);
  }
  if (Object.keys(routes).length === 0) {
    // Declaring `channels` is opt-in, so zero routes is a bug (a forgotten return, a conditional that
    // assembled nothing) — not a deployment that wants the default. Catch it, don't bind an all-404 server.
    throw new Error(
      "`channels` returned no routes \u2014 drop `channels` to serve the default POST /invoke, or return at least one route",
    );
  }
  for (const [key, handler] of Object.entries(routes)) {
    if (typeof handler !== "function") {
      throw new Error(`\`channels\` route "${key}" must be a handler function (got ${typeof handler})`);
    }
    // The path must be one router can actually match (see isMatchablePath) — else it binds an
    // unreachable, all-404 route. Validated against the real matching semantics, not a format blocklist.
    const { path } = parseRouteKey(key);
    if (!isMatchablePath(path)) {
      throw new Error(
        `\`channels\` route key "${key}" must be "/path" or "METHOD /path" — the path must be a plain URL pathname (leading "/", no whitespace, query, or fragment)`,
      );
    }
  }
  return routes as Routes;
}

/** A running Node host. */
export interface NodeHost {
  /** Resolves with the bound port once listening (useful for port 0); rejects on a bind error
   *  (e.g. EADDRINUSE) so the caller decides how to fail. */
  listening: Promise<number>;
  /** Await in-flight post-ACK work — call before exit on shutdown so none is dropped. */
  drain: () => Promise<void>;
  /** Stop accepting connections and close the server. */
  close: () => Promise<void>;
}

/**
 * Serve `handler` on a Node HTTP server, satisfying any `background` work in-process and tracking it
 * for {@link NodeHost.drain}. Pure mechanism: no logging, no signal handling, no process.exit — the
 * caller (CLI / app entry) owns those, so this stays reusable.
 */
export function serveNode(handler: ChannelHandler, options: { port: number }): NodeHost {
  const inFlight = new Set<Promise<unknown>>();
  const server = createServer(
    nodeListener(async (req) => {
      const result = await handler(req);
      if (result instanceof Response) return result;
      const { response, background } = result;
      if (background) {
        inFlight.add(background);
        // Observe rejections: a misbehaving channel's background must not crash the host as an
        // unhandled rejection (drain uses allSettled, but the tracking chain needs its own catch).
        void background
          .catch((error) => console.error(`[host] background work failed: ${String(error)}`))
          .finally(() => inFlight.delete(background));
      }
      return response;
    }),
  );
  const listening = new Promise<number>((resolve, reject) => {
    server.once("error", reject); // a bind failure surfaces here, before "listening"
    server.listen(options.port, () => {
      server.off("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
  return {
    listening,
    drain: () => Promise.allSettled(inFlight).then(() => {}),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
        server.closeIdleConnections(); // don't hang on idle keep-alive sockets
      }),
  };
}
