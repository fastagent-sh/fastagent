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

/**
 * Compose a {@link Routes} table into one handler: exact pathname match (optionally method-qualified),
 * 405 when the path exists under another method, 404 otherwise. No params/wildcards — channels mount
 * at fixed paths.
 */
export function router(routes: Routes): ChannelHandler {
  const entries = Object.entries(routes).map(([key, handler]) => {
    const sp = key.indexOf(" ");
    return sp === -1
      ? { method: undefined as string | undefined, path: key, handler }
      : { method: key.slice(0, sp).toUpperCase(), path: key.slice(sp + 1), handler };
  });
  return (req) => {
    const { pathname } = new URL(req.url);
    const onPath = entries.filter((e) => e.path === pathname);
    if (onPath.length === 0) return new Response("not found\n", { status: 404, headers: textHeaders });
    const match = onPath.find((e) => e.method === undefined || e.method === req.method);
    if (!match) return new Response("method not allowed\n", { status: 405, headers: textHeaders });
    return match.handler(req);
  };
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
        void background.finally(() => inFlight.delete(background));
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
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
