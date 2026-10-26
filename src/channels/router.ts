/**
 * How a {@link Routes} table becomes one Fetch handler: the path rule and dispatch. Every route a serve answers
 * verifies its own caller (a channel's platform signature, a host's IAM), or answers nothing worth guarding (the
 * health check), so the router adds no guard of its own. Fetch-only, so any runtime can serve it; serve.ts binds it to
 * node:http.
 */
import type { ChannelHandler, Routes } from "../channel.ts";
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

/** Same status and headers, no content (RFC 9110's HEAD). */
export function withoutBody(res: Response): Response {
  void res.body?.cancel().catch(() => {});
  return new Response(null, { status: res.status, statusText: res.statusText, headers: res.headers });
}

/** One handler over `routes`: a literal path, its method or any, HEAD answered from GET, else 405 or 404. */
export function router(routes: Routes): ChannelHandler {
  const byKey = new Map<string, ChannelHandler>();
  const paths = new Set<string>();
  for (const [key, handler] of Object.entries(routes)) {
    assertRouteKey(key, (problem) => `route "${key}" is not a valid route key — ${problem}`);
    const shadowed = [...byKey.keys()].find((other) => routeKeysConflict(other, key));
    if (shadowed) {
      throw new Error(`route "${key}" conflicts with "${shadowed}" — one of them would never receive a request`);
    }
    // Stored normalised: `parseRouteKey` upper-cases the method, so `"get /x"` validates under `GET` and would
    // otherwise be looked up under a name nothing stores.
    const { method, path } = parseRouteKey(key);
    byKey.set(method ? `${method} ${path}` : path, handler);
    paths.add(path);
  }
  return (req) => {
    // `URL` normalises the path (`/a/../x` → `/x`) and drops query/fragment.
    const path = new URL(req.url).pathname;
    const answer = (): Response | Promise<Response> => {
      const exact = byKey.get(`${req.method} ${path}`) ?? byKey.get(path);
      if (exact) return exact(req);
      if (req.method === "HEAD") {
        const get = byKey.get(`GET ${path}`);
        if (get) return get(req);
      }
      return paths.has(path) ? text("method not allowed\n", 405) : text("not found\n", 404);
    };
    if (req.method !== "HEAD") return answer();
    const res = answer();
    return res instanceof Promise ? res.then(withoutBody) : withoutBody(res);
  };
}
