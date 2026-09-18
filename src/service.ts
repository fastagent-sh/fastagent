/** The product, as one call: an agent directory becomes a live service. */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import type { Agent } from "./agent.ts";
import { createControlPlane } from "./channels/control.ts";
import { createInvokeHandler } from "./channels/http.ts";
import { text } from "./channels/respond.ts";
import { parseRouteKey, pathUnderPrefix, type PrefixMount, router } from "./channels/serve.ts";
import { type LoadedLongConnectionChannel, loadChannels } from "./channels/discover.ts";
import { loadSchedules } from "./schedule/discover.ts";
import { createScheduler } from "./schedule/scheduler.ts";
import type { SessionControl } from "./session.ts";
import type { ChannelHandler, LongConnection, Routes } from "./channel.ts";
import { log } from "./log.ts";
import { refuseBrokenDeclarations } from "./loader.ts";
import { gateSecrets } from "./secrets-gate.ts";
import type { LoadedSchedule } from "./schedule/schedule.ts";

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

export interface ServingSurface {
  routes: Routes;
  /** Prefix-owning handlers mounted beside the routes (the session control plane). */
  mounts?: readonly PrefixMount[];
  longConnections: LoadedLongConnectionChannel[];
  /** Route-channel basenames; the tunnel registers only this subset. */
  routeChannels: string[];
  /** Flip health between 200 and 503. */
  setReady(value: boolean): void;
}

/**
 * The surface this deployment serves: the DATA plane (`POST /invoke`), `GET /health`, and the discovered channels.
 *
 * `/invoke` is the framework's interface, so it is always there — it used to appear only when a definition declared
 * NO channel, which made "can I curl this deployment" depend on whether someone had added telegram. It is RESERVED
 * for the same reason `/control/*` is: a channel taking that path would silently replace the one route every client,
 * every doc and the startup line all name. `/health` stays overridable — a probe is the deployment's to shape.
 */
export async function routesFor(
  agentDir: string,
  agent: Agent,
  stateRoot: string,
  control: SessionControl | undefined,
  options: { builtinInvoke?: boolean } = {},
): Promise<ServingSurface> {
  const { routes, longConnections, routeChannels, collisions, failures } = await loadChannels(agentDir, {
    agent,
    stateRoot,
    control,
  });
  for (const c of collisions) {
    log.warn(`[fastagent] channel route "${c.route}" (${c.source}) collides with an earlier channel — not mounted`);
  }
  refuseBrokenDeclarations(failures);
  if (collisions.length > 0) {
    throw new Error(`${collisions.length} channel route collision(s) — two channels cannot serve one route`);
  }
  /** Does a channel already serve this path (for the method the built-in would answer)? */
  const covered = (path: string, method: string): boolean =>
    Object.keys(routes).some((key) => {
      const entry = parseRouteKey(key);
      return entry.path === path && (entry.method === undefined || entry.method === method);
    });
  if (covered("/invoke", "POST")) {
    throw new Error(
      `a channel serves "POST /invoke" — that path is the agent's own data plane (rename the channel route)`,
    );
  }
  let ready = longConnections.length === 0;
  const health = (): Response => (ready ? text("ok\n", 200) : text("starting\n", 503));
  const builtin: Routes = {
    ...(covered("/health", "GET") ? {} : { "GET /health": health }),
    // AgentCore serves the data plane through its own `/invocations` contract, so the adapter opts out.
    ...(options.builtinInvoke === false ? {} : { "POST /invoke": createInvokeHandler(agent) }),
  };
  return {
    routes: { ...builtin, ...routes },
    longConnections,
    routeChannels,
    setReady(value: boolean) {
      ready = value;
    },
  };
}

/** Refuse channel routes the control plane would swallow. */
export function assertNoControlPlaneCollision(channelRoutes: Routes, plane: PrefixMount): void {
  const collisions = Object.keys(channelRoutes).filter((key) => pathUnderPrefix(parseRouteKey(key).path, plane.prefix));
  if (collisions.length > 0) {
    throw new Error(
      `channel route(s) ${collisions.map((key) => `"${key}"`).join(", ")} collide with the session control plane — ` +
        `rename the channel route or disable sessionControl in fastagent.config`,
    );
  }
}

export function mountSessionControl(
  routes: Routes,
  control: SessionControl | undefined,
): {
  routes: Routes;
  mounts: PrefixMount[];
  /** The prefix the plane owns, when it is published — what a startup line names. */
  controlPrefix?: string;
} {
  if (!control) return { routes, mounts: [] };
  const plane = createControlPlane(control);
  assertNoControlPlaneCollision(routes, plane);
  return { routes, mounts: [plane], controlPrefix: plane.prefix };
}

/** Load and start the agent's `schedules/` — a time-trigger firing the agent on each cron. */
export async function startSchedules(
  agentDir: string,
  agent: Agent,
  stateRoot: string,
  selfSchedule: boolean,
  options: { externalClock?: boolean } = {},
): Promise<{ schedules: LoadedSchedule[]; stop: () => void }> {
  // Thrown, not exited on: this runs inside an embedder's app as well as the CLI, and a library that calls
  // process.exit takes a decision (degrade? retry? stop?) that belongs to its host.
  const { schedules, secrets, failures } = await loadSchedules(agentDir);
  // The schedules' half of the serving-path gate (the opener does the tools', loadChannels the
  // channels'): a schedule reads its env at IMPORT time, so an unset declared value has already
  // produced a broken prompt — refusing here is the last point where that is a startup failure.
  gateSecrets({ declared: secrets, failures });
  refuseBrokenDeclarations(failures);
  if (schedules.length === 0 && !selfSchedule) return { schedules, stop: () => {} };
  const scheduler = Effect.runSync(
    createScheduler({ agent, stateRoot, schedules, externalClock: options.externalClock }),
  );
  scheduler.start();
  if (schedules.length > 0) {
    log.info(
      `[fastagent] schedules: ${schedules.map((s) => s.name).join(", ")}${options.externalClock ? " (external clock — no resident cron timers)" : ""}`,
    );
  }
  return { schedules, stop: () => scheduler.stop() };
}

export interface AgentService {
  /** The assembled Fetch handler: channel routes, the control plane, and health. */
  handler: ChannelHandler;
  /** The agent behind it — invoke it directly when you also want a programmatic path. */
  agent: Agent;
  /** The literal routes `handler` was composed from — for a startup line naming what is served. */
  routes: Routes;
  agentDir: string;
  workspace: string;
  /**
   * What actually mounted, for a startup line: channel files serving routes, long connections, and whether the
   * built-in `POST /invoke` fallback is one of the routes.
   */
  channels: { routes: string[]; longConnections: string[] };
  schedules: readonly LoadedSchedule[];
  /** Settles when every long connection is up — immediately when there are none. */
  ready: Promise<void>;
  /** The control plane's prefix, when `sessionControl` is on. */
  controlPrefix?: string;
  /**
   * Stop long connections and schedules. It does NOT drain agent turns: a turn takes seconds to minutes, and the
   * deployment wants the old process gone in under a second (`SHUTDOWN_GRACE_MS` in `src/cli/serve.ts`). What makes
   * that safe is replay, not waiting — a chat turn's intent is durable before it is accepted and its channel
   * replays it on the next boot (`channels/kit/turn-store.ts`), and an in-flight HTTP/SSE caller sees the stream
   * drop and retries. The one path with neither is a schedule fire, whose claim is written before the turn: it
   * stays skipped, and the next boot records it as `interrupted` rather than losing it silently.
   */
  close(): Promise<void>;
}

/** What {@link mountAgentService} needs beyond an opened directory. */
export interface MountAgentServiceOptions {
  /** Wrap the agent before anything consumes it. */
  wrapAgent?: (agent: Agent) => Agent;
  /** Aborting this closes the service, exactly like calling {@link AgentService.close}. */
  signal?: AbortSignal;
  /** Called when a long connection ends on its own — a dropped socket-mode channel, say. */
  onChannelClosed?: (name: string, error?: unknown) => void;
  /** How long `close()` waits for a channel to stop before reporting it stuck (default 5s). */
  closeTimeoutMs?: number;
}

/** What the assembly needs from an opened agent directory — the whole of it. */
export interface MountableAgent {
  agent: Agent;
  /** The definition dir: where channels/, tools/ and schedules/ are read from. */
  agentDir: string;
  /** The agent's cwd. */
  workspace: string;
  /** Where durable state lives (channel state, sessions, schedule fires). */
  stateRoot: string;
  /** The session-control hub, when the opener built one. A serve has it whether or not `/control/*` is published:
   *  a chat channel's stop command reaches the running turn through it. */
  sessionControl?: SessionControl;
  /** Whether that hub is ALSO served as `/control/*` (`config.sessionControl`). Required, not defaulted: an
   *  embedder assembling this by hand would otherwise lose the plane to a 404 with nothing said anywhere. */
  publishControl: boolean;
  /** Whether the agent schedules its own follow-up turns. */
  selfSchedule: boolean;
}

/**
 * The assembly itself, over an already-opened directory: channels, the control plane, schedules and long connections,
 * composed into one handler.
 */
export async function mountAgentService(
  opened: MountableAgent,
  options: MountAgentServiceOptions = {},
): Promise<AgentService> {
  const { agentDir, workspace, stateRoot, sessionControl } = opened;
  // Wrapped BEFORE anything consumes it: routes, the control plane and schedules must all drive the same agent, so
  // this is a hook rather than something a caller applies afterwards.
  const agent = options.wrapAgent?.(opened.agent) ?? opened.agent;
  const closeTimeoutMs = options.closeTimeoutMs ?? CLOSE_DEADLINE_MS;

  const routed = await routesFor(agentDir, agent, stateRoot, sessionControl);
  const withControl = mountSessionControl(routed.routes, opened.publishControl ? sessionControl : undefined);
  // Composed BEFORE anything starts.
  const handler = router(withControl.routes, withControl.mounts);
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

      // Scope.close alone does not join concurrent closes or retain their failure.
      const shutdown = yield* Effect.cached(
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
      const onAbort = (): void => {
        void close().catch((error: unknown) => log.error(`[fastagent] service close failed: ${String(error)}`));
      };

      return yield* Effect.gen(function* () {
        // Registered first, so subscriptions and schedule timers stop before waiting for transports.
        yield* Effect.addFinalizer(() => closeWithin(runs, names, closeTimeoutMs).pipe(Effect.orDie));
        const scheduled = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () => startSchedules(agentDir, agent, stateRoot, opened.selfSchedule),
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

        if (options.signal?.aborted) yield* shutdown;
        else
          yield* Effect.acquireRelease(
            Effect.sync(() => options.signal?.addEventListener("abort", onAbort, { once: true })),
            () => Effect.sync(() => options.signal?.removeEventListener("abort", onAbort)),
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
          handler,
          agent,
          routes: withControl.routes,
          agentDir,
          workspace,
          channels: {
            routes: routed.routeChannels,
            longConnections: names,
          },
          schedules: scheduled.schedules,
          ready,
          ...(withControl.controlPrefix ? { controlPrefix: withControl.controlPrefix } : {}),
          close,
        };
      }).pipe(
        Scope.provide(lifetime),
        Effect.onError(() => rollback),
      );
    }),
  );
}
