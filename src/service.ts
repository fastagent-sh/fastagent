/** The product, as one call: an opened agent becomes a live service, its channels, schedules and wake-ups. */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import type { Agent } from "./agent-api.ts";
import type { ChannelHandler, LongConnection, Routes } from "./channel.ts";
import { type AnyChannelModule, type LoadedLongConnectionChannel, mountChannels } from "./channels/discover.ts";
import { text } from "./channels/respond.ts";
import { parseRouteKey, router } from "./channels/router.ts";
import { serveHandler, totalFetch } from "./channels/serve.ts";
import { log } from "./log.ts";
import { once } from "./once.ts";
import { type Scheduler, createScheduler } from "./schedule/scheduler.ts";
import type { Schedule } from "./schedule/schedule.ts";

/** Default wait for a channel's `closed` before reporting it stuck. */
const CLOSE_DEADLINE_MS = 5_000;

/** One deadline for all connections; a failed close must not hide a sibling that is still running. */
function closeWithin(
  runs: readonly LongConnection[],
  names: readonly string[],
  deadlineMs: number,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const pending = new Set(runs.map((_, i) => i));
    const failures: unknown[] = [];
    yield* Effect.forEach(
      runs,
      (run, i) =>
        Effect.tryPromise({ try: () => run.closed, catch: (error) => error }).pipe(
          Effect.match({
            onSuccess: () => {
              pending.delete(i);
            },
            onFailure: (error) => {
              pending.delete(i);
              failures.push(error);
            },
          }),
        ),
      { concurrency: "unbounded", discard: true },
    ).pipe(Effect.timeoutOrElse({ duration: deadlineMs, orElse: () => Effect.void }));
    if (pending.size > 0) {
      const stuck = [...pending].map((i) => names[i] ?? "channel");
      return yield* Effect.fail(
        new Error(`long connection(s) did not stop within ${deadlineMs}ms: ${stuck.join(", ")}`),
      );
    }
    if (failures.length > 0) {
      return yield* Effect.fail(
        failures.length === 1 ? failures[0] : new AggregateError(failures, "long connections failed to close"),
      );
    }
  });
}

/** The port a serve binds when neither a flag, `PORT` (start only) nor `http.port` names one. */
export const DEFAULT_HTTP_PORT = 8787;

/** What a serve answers: its channels' routes, and `GET /health` unless a channel serves it. */
interface ServingSurface {
  routes: Routes;
  longConnections: LoadedLongConnectionChannel[];
  /** Route-channel names; the tunnel registers only this subset. */
  routeChannels: string[];
  /** Flip health between 200 and 503. */
  setReady(value: boolean): void;
}

/** Mount the channels and the health check. */
export function routesFor(
  agent: Agent,
  stateRoot: string,
  channels: ReadonlyMap<string, AnyChannelModule>,
): ServingSurface {
  const { routes, longConnections, routeChannels } = mountChannels(channels, agent, stateRoot);
  let ready = longConnections.length === 0;
  const health = (): Response => (ready ? text("ok\n", 200) : text("starting\n", 503));
  const probed = Object.keys(routes).some((key) => {
    const entry = parseRouteKey(key);
    return entry.path === "/health" && (entry.method === undefined || entry.method === "GET");
  });
  return {
    // A probe is the deployment's to shape, so a channel may serve `/health` itself.
    routes: probed ? routes : { ...routes, "GET /health": health },
    longConnections,
    routeChannels,
    setReady(value: boolean) {
      ready = value;
    },
  };
}

/** Start the clock: the definition's schedules, and the wake-ups the agent sets for itself, on every serve. */
export function startSchedules(
  agent: Agent,
  stateRoot: string,
  schedules: readonly Schedule[],
  options: { localClock?: boolean } = {},
): Pick<Scheduler, "stop"> {
  const scheduler = Effect.runSync(
    createScheduler({
      agent,
      stateRoot,
      schedules,
      ...(options.localClock === false ? { localClock: false } : {}),
    }),
  );
  scheduler.start();
  if (schedules.length > 0) log.info(`[fastagent] schedules: ${schedules.map((s) => s.name).join(", ")}`);
  return scheduler;
}

/** What `serve()` answers (agent-api.md §8): the agent's channels, schedules and wake-ups, and `GET /health`. */
export interface Service {
  /** For an app's own server to route to. */
  fetch(request: Request): Promise<Response>;
  /** Or a server of its own, on this runtime's server: the one way to start one. Answers the port it bound. */
  listen(port: number, host?: string): Promise<number>;
  /** Settles when every long connection is up: immediately when there are none. */
  ready: Promise<void>;
  /**
   * Stop the server, giving the requests in flight a moment before ending them, then long connections and schedules.
   * It does NOT drain the agent's messages: one takes seconds to minutes, and the deployment wants the old process gone
   * in under a second. What makes that safe is that they are durable: an accepted message is answered after the
   * restart, and a chat turn's intent is durable before it is accepted (`channels/kit/turn-store.ts`). A schedule
   * fire's claim is written before its message: the next boot writes back the end of a message the agent took, and
   * records one it never took as `interrupted`.
   */
  close(): Promise<void>;
}

/** A serve as the CLI reports it: what it serves, beside the Service itself. */
export interface ServedAgent extends Service {
  /** The literal routes the service answers, for a startup line naming them. */
  routes: Routes;
  agentDir: string;
  /** What actually mounted: channels serving routes, and long connections. */
  channels: { routes: string[]; longConnections: string[] };
  schedules: readonly Schedule[];
}

/** A Service over `handler`: answered in process, or served on a server of its own; `shutdown` stops the rest. */
export function serviceOver(handler: ChannelHandler, ready: Promise<void>, shutdown: () => Promise<void>): Service {
  let listener: ReturnType<typeof serveHandler> | undefined;
  let closing: Promise<void> | undefined;
  const fetch = totalFetch(handler);
  return {
    fetch,
    listen(port, host) {
      if (closing !== undefined) return Promise.reject(new Error("the service is closed"));
      if (listener !== undefined) return Promise.reject(new Error("the service is already listening"));
      const current = serveHandler(handler, { port, ...(host === undefined ? {} : { host }) });
      listener = current;
      return current.listening.catch(async (error: unknown) => {
        // A bind that failed holds nothing once its scope is closed, so the service may listen again, elsewhere.
        if (listener === current) listener = undefined;
        await current.close();
        throw error;
      });
    },
    ready,
    close() {
      closing ??= (async () => {
        // The server first, so nothing new reaches what stops after it; each step runs, and every failure is said.
        const failures: unknown[] = [];
        for (const step of [() => listener?.close(), shutdown]) {
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
  /** Called when a long connection ends on its own — a dropped socket-mode channel, say. */
  onChannelClosed?: (name: string, error?: unknown) => void;
  /** How long `close()` waits for a channel to stop before reporting it stuck (default 5s). */
  closeTimeoutMs?: number;
}

/** What the assembly serves. */
export interface ServableAgent {
  agent: Agent;
  /** The definition's directory: the agent's working directory. */
  agentDir: string;
  /** Where durable state lives (channel state, schedule fires, wake-ups). */
  stateRoot: string;
  channels: ReadonlyMap<string, AnyChannelModule>;
  schedules: readonly Schedule[];
}

/** The assembly itself: channels, schedules and long connections, composed into one handler. */
export async function serveAgent(opened: ServableAgent, options: ServeOptions = {}): Promise<ServedAgent> {
  const { agent, agentDir, stateRoot, schedules } = opened;
  const closeTimeoutMs = options.closeTimeoutMs ?? CLOSE_DEADLINE_MS;
  const routed = routesFor(agent, stateRoot, opened.channels);
  // Composed BEFORE anything starts.
  const handler = router(routed.routes);
  return Effect.runPromise(
    Effect.gen(function* () {
      const lifetime = yield* Scope.make();
      const abort = new AbortController();
      const runs: LongConnection[] = [];
      const names = routed.longConnections.map((c) => c.name);
      // A connection lost during startup must not be hidden by a sibling becoming ready later.
      let dropped = false;
      const onClosed =
        options.onChannelClosed ??
        ((name, error) =>
          log.error(
            `[fastagent] long connection ${name} ${error === undefined ? "closed" : `failed: ${String(error)}`}`,
          ));
      const notifyClosed = (name: string, error?: unknown): void => {
        if (abort.signal.aborted) return;
        dropped = true;
        routed.setReady(false);
        onClosed(name, error);
      };

      // Scope.close alone does not join concurrent closes or retain their failure. Every later call, the rollback a
      // close itself triggers included, awaits the first one's outcome.
      const shutdown = once(
        Effect.gen(function* () {
          abort.abort();
          yield* Scope.close(lifetime, Exit.void);
        }),
      );
      const close = (): Promise<void> => Effect.runPromise(shutdown);
      const rollback = shutdown.pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() =>
            log.error(`[fastagent] cleanup after a failed start also failed: ${String(Cause.squash(cause))}`),
          ),
        ),
      );
      return yield* Effect.gen(function* () {
        // Registered first, so subscriptions and schedule timers stop before waiting for transports.
        yield* Effect.addFinalizer(() => closeWithin(runs, names, closeTimeoutMs).pipe(Effect.orDie));
        yield* Effect.acquireRelease(
          Effect.try({
            try: () => startSchedules(agent, stateRoot, schedules),
            catch: (error) => error,
          }),
          (scheduled) => Effect.sync(scheduled.stop),
        );
        const readiness = yield* Effect.forEach(routed.longConnections, (connection) =>
          Effect.gen(function* () {
            const run = yield* Effect.try({
              try: () => connection.connect(abort.signal),
              catch: (error) => error,
            });
            if (typeof run?.ready?.then !== "function" || typeof run?.closed?.then !== "function") {
              return yield* Effect.fail(
                new Error(`${connection.name} connect(signal) must return { ready: Promise, closed: Promise }`),
              );
            }
            runs.push(run);
            const closed = Effect.tryPromise({ try: () => run.closed, catch: (error) => error });
            yield* closed.pipe(
              Effect.match({
                onSuccess: () => notifyClosed(connection.name),
                onFailure: (error) => notifyClosed(connection.name, error),
              }),
              Effect.catchCause((cause) =>
                Effect.sync(() =>
                  log.error(`[fastagent] channel closure callback failed: ${String(Cause.squash(cause))}`),
                ),
              ),
              Effect.forkScoped({ startImmediately: true }),
            );
            // Observe ready immediately, including when a later connect() throws and mount rolls back.
            return yield* Effect.raceFirst(
              Effect.tryPromise({ try: () => run.ready, catch: (error) => error }),
              closed.pipe(
                Effect.matchEffect({
                  onSuccess: () => Effect.fail(new Error(`${connection.name} closed before it was ready`)),
                  onFailure: (error) =>
                    Effect.fail(new Error(`${connection.name} failed before it was ready: ${String(error)}`)),
                }),
              ),
            ).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  if (!abort.signal.aborted) log.info(`[fastagent] long connection ready: ${connection.name}`);
                }),
              ),
              Effect.forkScoped({ startImmediately: true }),
            );
          }),
        );

        // The public readiness waiter lives outside the scope it may roll back.
        const ready = Effect.runPromise(
          Effect.gen(function* () {
            yield* Effect.forEach(readiness, Fiber.join, { concurrency: "unbounded", discard: true });
            if (abort.signal.aborted) return yield* Effect.fail(new Error("service closed before it became ready"));
            if (dropped) return yield* Effect.fail(new Error("a long connection closed before startup completed"));
            routed.setReady(true);
          }).pipe(
            Effect.catchCause((cause) =>
              abort.signal.aborted
                ? Effect.fail(new Error("service closed before it became ready"))
                : Effect.failCause(cause),
            ),
            Effect.onError(() => rollback),
          ),
        );
        // The rejection is still delivered to callers that await ready.
        ready.catch(() => {});

        return {
          ...serviceOver(handler, ready, close),
          routes: routed.routes,
          agentDir,
          channels: { routes: routed.routeChannels, longConnections: names },
          schedules,
        };
      }).pipe(
        Scope.provide(lifetime),
        Effect.onError(() => rollback),
      );
    }),
  );
}
