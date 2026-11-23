/** The product, as one call: an opened agent becomes a live service: `GET /health`, and the
 * Agent API under `/v1` when it has a key. */
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import type { Agent, AuthApi, InvokeApi } from "@fastagent-sh/client/agent-api";
import { createCloseSignal } from "./close-signal.ts";
import { type Handler, serveHandler, totalFetch } from "./http/serve.ts";
import { cleanupQuietly } from "./promise-bridge.ts";
import { apiHandler, isApiPath } from "./http/server.ts";
import { text } from "./http/respond.ts";
import { log } from "./log.ts";

/** Run `work` at most once uninterruptibly; every caller shares its outcome (Effect 4.0 `cached` does not). */
function once<A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  const outcome = Deferred.makeUnsafe<A, E>();
  let started = false;
  return Effect.suspend(() => {
    if (started) return Deferred.await(outcome);
    started = true;
    return work.pipe(
      Effect.exit,
      Effect.flatMap((exit) => Deferred.done(outcome, exit)),
      Effect.uninterruptible,
      Effect.andThen(Deferred.await(outcome)),
    );
  });
}

/** The port a serve binds when neither a flag nor `PORT` (start only) names one. */
export const DEFAULT_HTTP_PORT = 8787;

/** What `serve()` answers: `GET /health`, and the Agent API with a key. */
export interface Service {
  /** For an app's own server to route to. */
  fetch(request: Request): Promise<Response>;
  /** Or a server of its own, on this runtime's server: the one way to start one. Answers the port it bound. */
  listen(port: number, host?: string): Promise<number>;
  /** The instance's remote authentication API, when opened on durable storage. */
  readonly auth?: AuthApi;
  /** Whether the service and underlying agent runtime are ready to accept work. */
  ready(): boolean;
  /**
   * Stop the server, giving requests in flight a moment before ending them. It does NOT drain
   * the agent's messages: accepted messages are durable and resume after a restart.
   */
  close(): Promise<void>;
}

/** A serve as the CLI and tests inspect it: whether the Agent API is mounted. */
export interface ServedAgent extends Service {
  /** Whether the Agent API is served, under `/v1`: only with a key. */
  api: boolean;
  /** Subscribe to the underlying agent runtime starting shutdown (fires synchronously on close start). */
  onRuntimeClose(listener: () => void): () => void;
}

/**
 * A Service over `handler`: answered in process, or served on a server of its own. `endStreams` ends what would hold
 * the server's close open (a Caller watching events), and `shutdown` stops the rest once the server has.
 */
export function serviceOver(
  handler: Handler,
  shutdown: () => Promise<void>,
  endStreams: () => Promise<void> = async () => {},
  isReady: () => boolean = () => true,
): Service {
  let listener: ReturnType<typeof serveHandler> | undefined;
  let closing: Promise<void> | undefined;
  const fetch = totalFetch(handler);
  return {
    fetch,
    ready: () => closing === undefined && isReady(),
    listen(port, host) {
      if (closing !== undefined) return Promise.reject(new Error("the service is closed"));
      if (listener !== undefined) return Promise.reject(new Error("the service is already listening"));
      const current = serveHandler(handler, { port, ...(host === undefined ? {} : { host }) });
      listener = current;
      return current.listening.then(
        (bound) => bound,
        async (error: unknown) => {
          // A bind that failed holds nothing once its scope is closed, so the service may listen again, elsewhere.
          if (listener === current) listener = undefined;
          await current.close();
          throw error;
        },
      );
    },
    close() {
      closing ??= (async () => {
        // The server first, so nothing new reaches what stops after it; each step runs, and every failure is said.
        const failures: unknown[] = [];
        for (const step of [endStreams, () => listener?.close(), shutdown]) {
          await Promise.resolve()
            .then(step)
            .catch((error: unknown) => failures.push(error));
        }
        if (failures.length > 0) {
          throw failures.length === 1 ? failures[0] : new AggregateError(failures, "the service did not close cleanly");
        }
      })();
      return closing;
    },
  };
}

/** What {@link serveAgent} needs beyond an opened agent. */
export interface ServeOptions {
  /** The keys the Agent API takes; without one it is not served. */
  apiKeys?: readonly string[];
}

/** What the assembly serves: the opened agent, its invoker, and its optional auth manager. */
interface ServableAgent {
  agent: Agent & {
    ready?(): boolean;
    subscribeClose?(listener: () => void): () => void;
  };
  invoker?: InvokeApi;
  auth?: AuthApi;
}

/** `GET /health` (and its HEAD) reflects agent readiness (200 ok, 503 unavailable once closing); nothing else outside the Agent API is here. */
function surface(api: ReturnType<typeof apiHandler> | undefined, isReady: () => boolean): Handler {
  return (req) => {
    const path = new URL(req.url).pathname;
    if (api !== undefined && isApiPath(path)) return api.fetch(req);
    if (path !== "/health") return text("not found\n", 404);
    if (req.method !== "GET" && req.method !== "HEAD") return text("method not allowed\n", 405);
    const ok = isReady();
    if (req.method === "HEAD") {
      return new Response(null, { status: ok ? 200 : 503, headers: { "content-type": "application/json" } });
    }
    return Response.json(ok ? { status: "ok" } : { status: "unavailable" }, { status: ok ? 200 : 503 });
  };
}

/** The assembly itself: `/health` and the Agent API with a key, composed into one handler. */
export async function serveAgent(opened: ServableAgent, options: ServeOptions = {}): Promise<ServedAgent> {
  const { agent, invoker, auth } = opened;
  const api = options.apiKeys?.length
    ? apiHandler(agent, {
        keys: options.apiKeys,
        ...(invoker === undefined ? {} : { invoker }),
        ...(auth === undefined ? {} : { auth }),
      })
    : undefined;
  const runtimeClose = createCloseSignal();
  if (agent.ready?.() === false) runtimeClose.mark();
  const unsubscribeClose = agent.subscribeClose?.(runtimeClose.mark);
  return Effect.runPromise(
    Effect.gen(function* () {
      const lifetime = yield* Scope.make();
      // Scope.close alone does not join concurrent closes or retain their failure. Every later call, the rollback a
      // close itself triggers included, awaits the first one's outcome.
      const shutdown = once(Scope.close(lifetime, Exit.void));
      const rollback = shutdown.pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() =>
            log.error(`[fastagent] cleanup after a failed start also failed: ${String(Cause.squash(cause))}`),
          ),
        ),
      );
      return yield* Effect.gen(function* () {
        if (unsubscribeClose !== undefined) {
          yield* Effect.addFinalizer(() => Effect.sync(unsubscribeClose));
        }
        if (api !== undefined) yield* Effect.addFinalizer(() => cleanupQuietly("closing the Agent API", api.dispose));
        let serviceClosing = false;
        const isReady = () => !serviceClosing && !runtimeClose.isClosing();
        const base = serviceOver(
          surface(api, isReady),
          () => Effect.runPromise(shutdown),
          async () => {
            serviceClosing = true;
            await api?.endStreams();
          },
          isReady,
        );
        return {
          ...base,
          close: () => {
            serviceClosing = true;
            return base.close();
          },
          ...(auth === undefined ? {} : { auth }),
          api: api !== undefined,
          onRuntimeClose: runtimeClose.subscribe,
        };
      }).pipe(
        Scope.provide(lifetime),
        Effect.onError(() => rollback),
      );
    }),
  );
}
