/** The server a Fetch handler is served on, behind the totality boundary every serving path shares. */
import { createServer } from "node:http";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { HttpEffect, HttpServer, HttpServerError } from "effect/http";
import type * as NetAddress from "effect/net/NetAddress";
import type { ChannelHandler } from "../channel.ts";
import { LIMITS } from "../agent-api.ts";
import { log } from "../log.ts";
import { text } from "./respond.ts";

/** The totality boundary every serving path shares; `prepare` shapes the handler's response inside it. */
export function totalFetch(
  handler: ChannelHandler,
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

const isBun = typeof process.versions.bun === "string";

/**
 * How long `close()` gives the requests in flight before it ends them, on either runtime: a webhook is answered in
 * milliseconds, and a close must fit the CLI's shutdown deadline (`FORCED_EXIT_MS` in `src/cli/serve.ts`).
 */
const GRACEFUL_SHUTDOWN = "500 millis";

/**
 * How long Bun lets a response say nothing before it ends it (10 s by default): longer than an Agent API request waits
 * for a message, and than an event stream's keep-alive interval. Node sets no such limit.
 */
const BUN_IDLE_TIMEOUT_SECONDS = LIMITS.httpWaitSeconds + 15;

/** The server this runtime serves on: Node's `http.Server`, or `Bun.serve`. */
async function serverLayer(options: {
  port: number;
  host?: string;
}): Promise<Layer.Layer<HttpServer.HttpServer, HttpServerError.ServeError>> {
  if (isBun) {
    const { layer } = await import("@effect/platform-bun/BunHttpServer");
    return layer({
      port: options.port,
      ...(options.host === undefined ? {} : { hostname: options.host }),
      gracefulShutdownTimeout: GRACEFUL_SHUTDOWN,
      idleTimeout: BUN_IDLE_TIMEOUT_SECONDS,
    });
  }
  const { layer } = await import("@effect/platform-node/NodeHttpServer");
  return layer(() => createServer(), {
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
export function serveHandler(
  handler: ChannelHandler,
  options: { port: number; host?: string },
): { listening: Promise<number>; close: () => Promise<void> } {
  const scope = Scope.makeUnsafe();
  let closed = false;
  // A server runs each request uninterruptibly unless told otherwise; a request that has not answered when the server
  // closes must be interruptible, or closing waits on it forever.
  const app = Effect.interruptible(
    HttpEffect.fromWebHandler((request) => {
      // The handler's `signal` follows its client to the end of the response, as a Node server's request does: this
      // server aborts it only while the handler runs, so a body cancelled because the client left aborts it too.
      const left = new AbortController();
      const followed = new Request(request, { signal: AbortSignal.any([request.signal, left.signal]) });
      return totalFetch(handler, (response) => watchedBody(response, () => left.abort()))(followed);
    }),
  );
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
