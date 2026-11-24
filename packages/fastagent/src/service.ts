/** The product, as one call: an opened agent becomes a live service: `GET /health`, and the
 * Agent API under `/v1` when it has a key. */
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import type { Agent, AuthApi, InvokeApi } from "@fastagent-sh/client/agent-api";
import { createCloseSignal } from "./close-signal.ts";
import { type SecretInput, redactSecret } from "./declared-secrets.ts";
import { text } from "./http/respond.ts";
import { type Handler, serveHandler, totalFetch } from "./http/serve.ts";
import { apiHandler, isApiPath } from "./http/server.ts";
import { log } from "./log.ts";
import { PromiseFailure, cleanupQuietly, fromPromise, originalError } from "./promise-bridge.ts";

/** Run `work` at most once uninterruptibly; every caller shares its outcome (Effect 4.0 `cached` does not). */
function once<A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  const outcome = Deferred.makeUnsafe<A, E>();
  const started = Ref.makeUnsafe(false);
  return Effect.gen(function* () {
    const isLeader = yield* Ref.modify(started, (already) => [!already, true] as const);
    if (!isLeader) return yield* Deferred.await(outcome);
    return yield* work.pipe(
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

type ServiceState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "listening"; readonly listener: ReturnType<typeof serveHandler> }
  | { readonly _tag: "closed"; readonly closing: Deferred.Deferred<void, PromiseFailure> };

/** Run an Effect whose failures carry original causes in `PromiseFailure`, rejecting with the original cause. */
async function runServicePromise<A>(effect: Effect.Effect<A, PromiseFailure>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw originalError(exit.cause);
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
  const state = Ref.makeUnsafe<ServiceState>({ _tag: "idle" });
  const fetch = totalFetch(handler);

  const listenEffect = Effect.fn("service.listen")(function* (port: number, host?: string) {
    const acquired = yield* Ref.modify(
      state,
      (
        current,
      ): readonly [
        (
          | { readonly _tag: "ok"; readonly listener: ReturnType<typeof serveHandler> }
          | { readonly _tag: "refused"; readonly reason: string }
        ),
        ServiceState,
      ] => {
        if (current._tag === "closed") return [{ _tag: "refused", reason: "the service is closed" }, current];
        if (current._tag === "listening") {
          return [{ _tag: "refused", reason: "the service is already listening" }, current];
        }
        const listener = serveHandler(handler, { port, ...(host === undefined ? {} : { host }) });
        return [
          { _tag: "ok", listener },
          { _tag: "listening", listener },
        ];
      },
    );
    if (acquired._tag === "refused") {
      return yield* Effect.fail(new PromiseFailure(new Error(acquired.reason)));
    }
    const current = acquired.listener;
    return yield* fromPromise(() => current.listening).pipe(
      Effect.onError(() =>
        // A bind that failed holds nothing once its scope is closed, so the service may listen again, elsewhere.
        Ref.update(
          state,
          (s): ServiceState => (s._tag === "listening" && s.listener === current ? { _tag: "idle" } : s),
        ).pipe(Effect.andThen(cleanupQuietly("closing failed listener", current.close))),
      ),
    );
  });

  const closeEffect = Effect.fn("service.close")(function* () {
    const decision = yield* Ref.modify(
      state,
      (
        current,
      ): readonly [
        (
          | { readonly _tag: "join"; readonly closing: Deferred.Deferred<void, PromiseFailure> }
          | {
              readonly _tag: "lead";
              readonly closing: Deferred.Deferred<void, PromiseFailure>;
              readonly listener: ReturnType<typeof serveHandler> | undefined;
            }
        ),
        ServiceState,
      ] => {
        if (current._tag === "closed") return [{ _tag: "join", closing: current.closing }, current];
        const closing = Deferred.makeUnsafe<void, PromiseFailure>();
        const listener = current._tag === "listening" ? current.listener : undefined;
        return [
          { _tag: "lead", closing, listener },
          { _tag: "closed", closing },
        ];
      },
    );
    if (decision._tag === "join") return yield* Deferred.await(decision.closing);
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        // The server first, so nothing new reaches what stops after it; each step runs, and every failure is said.
        const steps: readonly (() => Promise<void>)[] = [
          endStreams,
          () => (decision.listener === undefined ? Promise.resolve() : decision.listener.close()),
          shutdown,
        ];
        const failures: unknown[] = [];
        for (const step of steps) {
          const exit = yield* Effect.exit(fromPromise(step));
          if (Exit.isFailure(exit)) failures.push(originalError(exit.cause));
        }
        const finalExit =
          failures.length === 0
            ? Exit.void
            : Exit.fail(
                new PromiseFailure(
                  failures.length === 1
                    ? failures[0]
                    : new AggregateError(failures, "the service did not close cleanly"),
                ),
              );
        yield* Deferred.done(decision.closing, finalExit);
      }),
    );
    return yield* Deferred.await(decision.closing);
  });

  return {
    fetch,
    ready: () => Ref.getUnsafe(state)._tag !== "closed" && isReady(),
    listen: (port, host) => runServicePromise(listenEffect(port, host)),
    close: () => runServicePromise(closeEffect()),
  };
}

/** What {@link serveAgent} needs beyond an opened agent. */
export interface ServeOptions {
  /** The keys the Agent API takes; without one it is not served. */
  apiKeys?: readonly SecretInput[];
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

const serveAgentEffect = Effect.fn("service.serveAgent")(function* (opened: ServableAgent, options: ServeOptions = {}) {
  const { agent, invoker, auth } = opened;
  const api = options.apiKeys?.length
    ? apiHandler(agent, {
        keys: options.apiKeys.map(redactSecret),
        ...(invoker === undefined ? {} : { invoker }),
        ...(auth === undefined ? {} : { auth }),
      })
    : undefined;
  const runtimeClose = createCloseSignal();
  if (agent.ready?.() === false) runtimeClose.mark();
  const unsubscribeClose = agent.subscribeClose?.(runtimeClose.mark);
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
    const serviceClose = createCloseSignal();
    const isReady = () => !serviceClose.isClosing() && !runtimeClose.isClosing();
    const base = serviceOver(
      surface(api, isReady),
      () => Effect.runPromise(shutdown),
      async () => {
        serviceClose.mark();
        await api?.endStreams();
      },
      isReady,
    );
    return {
      ...base,
      close: () => {
        serviceClose.mark();
        return base.close();
      },
      ...(auth === undefined ? {} : { auth }),
      api: api !== undefined,
      onRuntimeClose: runtimeClose.subscribe,
    } satisfies ServedAgent;
  }).pipe(
    Scope.provide(lifetime),
    Effect.onError(() => rollback),
  );
});

/** The assembly itself: `/health` and the Agent API with a key, composed into one handler. */
export function serveAgent(opened: ServableAgent, options: ServeOptions = {}): Promise<ServedAgent> {
  return Effect.runPromise(serveAgentEffect(opened, options));
}
