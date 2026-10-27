/** The server a Fetch handler is served on, behind the totality boundary every serving path shares. */
import { getRequestListener } from "@hono/node-server";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { HttpEffect, HttpServer, HttpServerError } from "effect/http";
import type * as NetAddress from "effect/net/NetAddress";
import type { ChannelHandler } from "../channel.ts";
import { log } from "../log.ts";
import { text } from "./respond.ts";

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

/**
 * A response whose body fails mid-flight, said in the log. Once the headers are out the failure can only cut the body
 * short, and the server this binds to reports nothing of it; the client sees a truncated body and nothing more.
 */
function watchedBody(response: Response): Response {
  if (response.body === null) return response;
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        log.error(`[serve] a response body failed mid-flight: ${String(error)}`);
        controller.error(error);
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

const isBun = typeof process.versions.bun === "string";

/**
 * How long `close()` waits for requests in flight before interrupting them. `dev` and `start` force their connections
 * shut right after (`closeAllConnections`), so this bounds only Bun, which gives no handle to do that.
 */
const GRACEFUL_SHUTDOWN = "500 millis";

/** The server this runtime serves on: Node's, around an `http.Server` we keep to force connections shut; Bun's own. */
async function serverLayer(
  options: { port: number; host?: string },
  nodeServer: Server | undefined,
): Promise<Layer.Layer<HttpServer.HttpServer, HttpServerError.ServeError>> {
  if (nodeServer === undefined) {
    const { layer } = await import("@effect/platform-bun/BunHttpServer");
    return layer({
      port: options.port,
      ...(options.host === undefined ? {} : { hostname: options.host }),
      gracefulShutdownTimeout: GRACEFUL_SHUTDOWN,
    });
  }
  const { layer } = await import("@effect/platform-node/NodeHttpServer");
  return layer(() => nodeServer, {
    port: options.port,
    ...(options.host === undefined ? {} : { host: options.host }),
    gracefulShutdownTimeout: GRACEFUL_SHUTDOWN,
  });
}

/** A bind that failed, as the error its runtime raised (`EADDRINUSE` and the like), not Effect's wrapper of it. */
function bindFailure(error: unknown): unknown {
  return error instanceof HttpServerError.ServeError ? error.cause : error;
}

/** Serve `handler` on this runtime's own server: Node's `http.Server`, or `Bun.serve`. */
export function serveNode(
  handler: ChannelHandler,
  options: { port: number; host?: string },
): { listening: Promise<number>; close: () => Promise<void>; closeAllConnections: () => void } {
  const nodeServer = isBun ? undefined : createServer();
  const scope = Scope.makeUnsafe();
  // A server runs each request uninterruptibly unless told otherwise; a request that has not answered when the server
  // closes must be interruptible, or closing waits on it forever.
  const total = totalFetch(handler);
  const app = Effect.interruptible(HttpEffect.fromWebHandler(async (request) => watchedBody(await total(request))));
  const listening = serverLayer(options, nodeServer)
    .then((server) =>
      Effect.runPromise(Layer.buildWithScope(HttpServer.serve(app).pipe(Layer.provideMerge(server)), scope)),
    )
    .then(
      (context) => (Context.get(context, HttpServer.HttpServer).address as NetAddress.InetAddress).port,
      (error: unknown) => {
        throw bindFailure(error);
      },
    );
  return {
    listening,
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
    closeAllConnections: () => nodeServer?.closeAllConnections(),
  };
}
