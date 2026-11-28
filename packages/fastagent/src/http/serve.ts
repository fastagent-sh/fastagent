/** The server a Fetch handler is served on, behind the totality boundary every serving path shares. */
import { createServer } from "node:http";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { HttpEffect, HttpServer, HttpServerError } from "effect/http";
import type * as NetAddress from "effect/net/NetAddress";
import { log } from "../log.ts";
import { isBunRuntime } from "../runtime.ts";
import { text } from "./respond.ts";

/** A Fetch handler: what a serve answers a request with. */
export type Handler = (req: Request) => Response | Promise<Response>;

/** The totality boundary every serving path shares; `prepare` shapes the handler's response inside it. */
export function totalFetch(
  handler: Handler,
  prepare: (response: Response) => Response = (response) => response,
): (req: Request) => Promise<Response> {
  return async (req) => {
    try {
      const response = await handler(req);
      if (!(response instanceof Response)) throw new TypeError("handler did not return a Response");
      return prepare(response);
    } catch (error) {
      log.error(`[serve] request failed: ${String(error)}`);
      return text("internal error\n", 500);
    }
  };
}

/**
 * A response whose body fails mid-flight, said in the log. Once the headers are out the failure can only cut the body
 * short, and the server this binds to reports nothing of it; the client sees a truncated body and nothing more. A
 * client that leaves is not a failure: the server cancels the body, which ends the read in progress and calls `left`.
 */
function watchedBody(response: Response, left: () => void): Response {
  if (response.body === null) return response;
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await reader.read();
      } catch (error) {
        log.error(`[serve] a response body failed mid-flight: ${String(error)}`);
        controller.error(error);
        return;
      }
      // Outside the try: when the client left, the read in progress ends `done` on a body already cancelled, and
      // closing it throws; that is not the body failing.
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel(reason) {
      left();
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/**
 * How long `close()` gives in-flight HTTP requests before ending them, sized to fit the CLI's shutdown deadline
 * (`FORCED_EXIT_MS` in `src/cli/serve.ts`).
 */
const GRACEFUL_SHUTDOWN_MS = 500;
const GRACEFUL_SHUTDOWN = `${GRACEFUL_SHUTDOWN_MS} millis` as const;

interface BunServerHandle {
  readonly port: number | undefined;
  stop(closeActiveConnections?: boolean): Promise<void>;
}

interface BunGlobal {
  serve(options: {
    port: number;
    hostname?: string;
    idleTimeout?: number;
    fetch(request: Request): Response | Promise<Response>;
  }): BunServerHandle;
}

function wrappedHandler(handler: Handler): (request: Request) => Promise<Response> {
  return (request) => {
    // The handler's `signal` follows its client to the end of the response: a body cancelled because the client left
    // aborts it too, even after headers are out.
    const left = new AbortController();
    const followed = new Request(request, { signal: AbortSignal.any([request.signal, left.signal]) });
    return totalFetch(handler, (response) => watchedBody(response, () => left.abort()))(followed);
  };
}

/** Serve `handler` directly on Bun's native Fetch server, avoiding the `node:http` shim layer. */
function serveOnBun(
  bun: BunGlobal,
  handler: Handler,
  options: { port: number; host?: string },
): { listening: Promise<number>; close: () => Promise<void> } {
  const fetch = wrappedHandler(handler);
  let server: BunServerHandle | undefined;
  let closing: Promise<void> | undefined;
  const listening = Promise.resolve().then(() => {
    if (closing !== undefined) throw new Error("the server was closed before it listened");
    server = bun.serve({
      port: options.port,
      ...(options.host === undefined ? {} : { hostname: options.host }),
      // Disable Bun's 10s default idle socket timeout so long-polling `invoke?wait=600` and quiet SSE streams survive.
      idleTimeout: 0,
      fetch,
    });
    if (server.port === undefined) throw new Error("Bun.serve did not bind a TCP port");
    return server.port;
  });
  return {
    listening,
    close() {
      if (closing !== undefined) return closing;
      closing = (async () => {
        await listening.then(
          () => undefined,
          () => undefined,
        );
        if (server === undefined) return;
        const active = server;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), GRACEFUL_SHUTDOWN_MS);
        });
        const outcome = await Promise.race([active.stop(false).then(() => "stopped" as const), deadline]);
        if (timer !== undefined) clearTimeout(timer);
        if (outcome === "timeout") await active.stop(true);
      })();
      return closing;
    },
  };
}

/** The server a serve listens on under Node: Node's `http.Server`. */
async function serverLayer(options: {
  port: number;
  host?: string;
}): Promise<Layer.Layer<HttpServer.HttpServer, HttpServerError.ServeError>> {
  const { layer } = await import("@effect/platform-node/NodeHttpServer");
  return layer(() => createServer({ requestTimeout: 0, headersTimeout: 60_000 }), {
    port: options.port,
    ...(options.host === undefined ? {} : { host: options.host }),
    gracefulShutdownTimeout: GRACEFUL_SHUTDOWN,
  });
}

/** A bind that failed, as the error its runtime raised (`EADDRINUSE` and the like), not Effect's wrapper of it. */
function bindFailure(error: unknown): unknown {
  return error instanceof HttpServerError.ServeError ? error.cause : error;
}

/** Serve `handler` on the host runtime's native HTTP server (Node's `http.Server` or Bun's `Bun.serve`). */
export function serveHandler(
  handler: Handler,
  options: { port: number; host?: string },
): { listening: Promise<number>; close: () => Promise<void> } {
  const bun = (globalThis as { readonly Bun?: BunGlobal }).Bun;
  if (isBunRuntime() && bun !== undefined) return serveOnBun(bun, handler, options);

  const scope = Scope.makeUnsafe();
  let closed = false;
  // A server runs each request uninterruptibly unless told otherwise; a request that has not answered when the server
  // closes must be interruptible, or closing waits on it forever.
  const app = Effect.interruptible(HttpEffect.fromWebHandler(wrappedHandler(handler)));
  const listening = serverLayer(options)
    .then((server) => {
      if (closed) throw new Error("the server was closed before it listened");
      return Effect.runPromise(Layer.buildWithScope(HttpServer.serve(app).pipe(Layer.provideMerge(server)), scope));
    })
    .then(
      (context) => (Context.get(context, HttpServer.HttpServer).address as NetAddress.InetAddress).port,
      (error: unknown) => {
        throw bindFailure(error);
      },
    );
  return {
    listening,
    async close() {
      closed = true;
      // A bind in progress finishes first, so what it bound is released here; how it ended is `listening`'s to say.
      await listening.then(
        () => undefined,
        () => undefined,
      );
      await Effect.runPromise(Scope.close(scope, Exit.void));
    },
  };
}
