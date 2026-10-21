/** Literal HTTP routes with percent-encoded path parameters, method dispatch and one error boundary. */
import type { ChannelHandler } from "../channel.ts";
import { text } from "./respond.ts";
import { parseRouteKey, withoutBody } from "./router.ts";

type Params = Record<string, string>;
export type HttpHandler = (req: Request, url: URL, params: Params) => Response | Promise<Response>;

/**
 * A mounted table of `"<METHOD> <path>"` → handler, where a `{name}` segment is a percent-encoded variable. A segment
 * that does not decode, or decodes to an id no URL can carry, matches nothing.
 */
export function httpTable(
  table: Record<string, HttpHandler>,
  onError: (req: Request, url: URL, error: unknown) => Response,
): ChannelHandler {
  const routes = Object.entries(table).map(([key, handler]) => {
    const { method, path } = parseRouteKey(key);
    return { method, segments: path.split("/"), handler };
  });
  return async (req) => {
    const url = new URL(req.url);
    const segments = url.pathname.split("/");
    const hits: { route: (typeof routes)[number]; params: Params }[] = [];
    for (const route of routes) {
      if (route.segments.length !== segments.length) continue;
      const params: Params = {};
      const matched = route.segments.every((expected, i) => {
        const actual = segments[i] as string;
        if (!expected.startsWith("{")) return expected === actual;
        if (actual === "") return false;
        try {
          params[expected.slice(1, -1)] = decodeURIComponent(actual);
          return true;
        } catch {
          return false;
        }
      });
      if (matched) hits.push({ route, params });
    }
    const hit =
      hits.find((h) => h.route.method === req.method) ??
      (req.method === "HEAD" ? hits.find((h) => h.route.method === "GET") : undefined);
    let res: Response;
    try {
      res = hit
        ? await hit.route.handler(req, url, hit.params)
        : hits.length > 0
          ? text("method not allowed\n", 405)
          : text("not found\n", 404);
    } catch (error) {
      res = onError(req, url, error);
    }
    return req.method === "HEAD" ? withoutBody(res) : res;
  };
}
