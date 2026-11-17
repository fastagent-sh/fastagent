/** The product, as one call: an opened agent becomes a live service: its schedules and wake-ups, `GET /health`, and the
 * Agent API under `/v1` when it has a key. */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import type { Agent } from "@fastagent-sh/client/agent-api";
import { type Handler, serveHandler, totalFetch } from "./http/serve.ts";
import { cleanupQuietly } from "./promise-bridge.ts";
import { apiHandler, isApiPath } from "./http/server.ts";
import { text } from "./http/respond.ts";
import { log } from "./log.ts";
import { once } from "./once.ts";
import { type Scheduler, createScheduler } from "./schedule/scheduler.ts";
import type { ClockStore } from "./schedule/clock.ts";
import type { Schedule } from "./schedule/schedule.ts";

/** The port a serve binds when neither a flag nor `PORT` (start only) names one. */
export const DEFAULT_HTTP_PORT = 8787;

/** Start the clock: the definition's schedules, and the wake-ups the agent sets for itself, on every serve. */
async function startSchedules(
  agent: Agent,
  clock: ClockStore,
  schedules: readonly Schedule[],
): Promise<Pick<Scheduler, "stop">> {
  const scheduler = Effect.runSync(createScheduler({ agent, clock, schedules }));
  await scheduler.start().catch((error: unknown) => {
    scheduler.stop();
    throw error;
  });
  if (schedules.length > 0) log.info(`[fastagent] schedules: ${schedules.map((s) => s.name).join(", ")}`);
  return scheduler;
}

/** What `serve()` answers: the agent's schedules and wake-ups, `GET /health`, and the Agent API with a key. */
export interface Service {
  /** For an app's own server to route to. */
  fetch(request: Request): Promise<Response>;
  /** Or a server of its own, on this runtime's server: the one way to start one. Answers the port it bound. */
  listen(port: number, host?: string): Promise<number>;
  /**
   * Stop the server, giving the requests in flight a moment before ending them, then the schedules. It does NOT drain
   * the agent's messages: one takes seconds to minutes, and the deployment wants the old process gone in under a
   * second. What makes that safe is that they are durable: an accepted message is answered after the restart. A
   * schedule fire's claim is written before its message: the next boot writes back the end of a message the agent
   * took, and records one it never took as `interrupted`.
   */
  close(): Promise<void>;
}

/** A serve as the CLI reports it: what it serves, beside the Service itself. */
export interface ServedAgent extends Service {
  agentDir: string;
  schedules: readonly Schedule[];
  /** Whether the Agent API is served, under `/v1`: only with a key. */
  api: boolean;
}

/**
 * A Service over `handler`: answered in process, or served on a server of its own. `endStreams` ends what would hold
 * the server's close open (a Caller watching events), and `shutdown` stops the rest once the server has.
 */
export function serviceOver(
  handler: Handler,
  shutdown: () => Promise<void>,
  endStreams: () => Promise<void> = async () => {},
): Service {
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

/** What the assembly serves. */
export interface ServableAgent {
  agent: Agent;
  /** The project directory the instance's `.secrets/` belong to. */
  agentDir: string;
  /** Where its clock keeps its state (fires, wake-ups): without one, nothing fires. */
  clock?: ClockStore;
  schedules: readonly Schedule[];
}

/** `GET /health` (and its HEAD) answers once the service is up; anything else outside the Agent API is not here. */
function surface(api: ReturnType<typeof apiHandler> | undefined): Handler {
  return (req) => {
    const path = new URL(req.url).pathname;
    if (api !== undefined && isApiPath(path)) return api.fetch(req);
    if (path !== "/health") return text("not found\n", 404);
    if (req.method === "HEAD")
      return new Response(null, { status: 200, headers: { "content-type": "application/json" } });
    return req.method === "GET" ? Response.json({ status: "ok" }) : text("method not allowed\n", 405);
  };
}

/** The assembly itself: the schedules, and the Agent API with a key, composed into one handler. */
export async function serveAgent(opened: ServableAgent, options: ServeOptions = {}): Promise<ServedAgent> {
  const { agent, agentDir, clock, schedules } = opened;
  const api = options.apiKeys?.length ? apiHandler(agent, { keys: options.apiKeys }) : undefined;
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
        if (api !== undefined) yield* Effect.addFinalizer(() => cleanupQuietly("closing the Agent API", api.dispose));
        if (clock !== undefined) {
          yield* Effect.acquireRelease(
            Effect.tryPromise({
              try: () => startSchedules(agent, clock, schedules),
              catch: (error) => error,
            }),
            (scheduled) => Effect.sync(scheduled.stop),
          );
        }
        return {
          ...serviceOver(
            surface(api),
            () => Effect.runPromise(shutdown),
            async () => api?.endStreams(),
          ),
          agentDir,
          schedules,
          api: api !== undefined,
        };
      }).pipe(
        Scope.provide(lifetime),
        Effect.onError(() => rollback),
      );
    }),
  );
}
