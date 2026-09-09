/** The product, as one call: an agent directory becomes a live service. */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import type { Agent } from "./agent.ts";
import { CONTROL_TOKEN_ENV, createControlPlane } from "./channels/control.ts";
import { createInvokeHandler } from "./channels/http.ts";
import { text } from "./channels/respond.ts";
import { parseRouteKey, pathUnderPrefix, type PrefixMount, router } from "./channels/serve.ts";
import { type LoadedLongConnectionChannel, loadChannels } from "./channels/discover.ts";
import { loadSchedules } from "./schedule/discover.ts";
import { createScheduler } from "./schedule/scheduler.ts";
import type { SessionControl } from "./session.ts";
import type { ChannelHandler, LongConnection, Routes } from "./channel.ts";
import { log } from "./log.ts";
import { reportModuleLoadFailures } from "./loader.ts";
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
  builtinInvoke: boolean;
  /** Flip health between 200 and 503. */
  setReady(value: boolean): void;
}

/**
 * The surface this deployment serves: default `GET /health` plus discovered channels, or the default POST `/invoke`
 * only when neither a route nor a long-connection channel was declared.
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
  reportModuleLoadFailures(failures);
  if (failures.length > 0 || collisions.length > 0) {
    throw new Error(
      `channel setup is invalid (${failures.length} load failure(s), ${collisions.length} route collision(s)) — ` +
        `fix it, or rename an intentionally disabled file to *.disabled`,
    );
  }
  const builtinInvoke =
    options.builtinInvoke !== false && Object.keys(routes).length === 0 && longConnections.length === 0;
  const channels = builtinInvoke ? { "POST /invoke": createInvokeHandler(agent) } : routes;
  const healthCovered = Object.keys(channels).some((key) => {
    const entry = parseRouteKey(key);
    return entry.path === "/health" && (entry.method === undefined || entry.method === "GET");
  });
  let ready = longConnections.length === 0;
  const health = (): Response => (ready ? text("ok\n", 200) : text("starting\n", 503));
  return {
    routes: healthCovered ? channels : { "GET /health": health, ...channels },
    longConnections,
    routeChannels,
    builtinInvoke,
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
  options: { agent?: Agent } = {},
): {
  routes: Routes;
  mounts: PrefixMount[];
  /**
   * The plane's bearer token and prefix — how a caller distributes access (the CLI writes it to
   * `<stateRoot>/control.json` for local discovery; an embedder hands it out itself).
   */
  control?: { token: string; prefix: string };
} {
  if (!control) return { routes, mounts: [] };
  // WHO OWNS the secret.
  const injected = process.env[CONTROL_TOKEN_ENV]?.trim();
  // SET BUT EMPTY is the deployed default, not an edge case.
  if (injected === "") {
    log.warn(
      `[fastagent] ${CONTROL_TOKEN_ENV} is set but empty — minting a per-boot token instead; callers holding ` +
        "the deploy-time value will get 401 (set it, or read the minted one from control.json on the box)",
    );
  } else if (injected !== undefined && injected.length < 16) {
    // Length is a crude proxy for entropy — sixteen `a`s pass.
    log.warn(
      `[fastagent] ${CONTROL_TOKEN_ENV} is ${injected.length} characters — it is the ONLY thing between ` +
        "/control/* (steer, stop, rewrite a session) and anyone who can reach the port; use a random value (uuidgen)",
    );
  }
  const token = injected || crypto.randomUUID();
  const plane = createControlPlane(control, { token, agent: options.agent });
  assertNoControlPlaneCollision(routes, plane);
  return { routes, mounts: [plane], control: { token, prefix: plane.prefix } };
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
  const { schedules, failures } = await loadSchedules(agentDir);
  reportModuleLoadFailures(failures);
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
  channels: { routes: string[]; longConnections: string[]; builtinInvoke: boolean };
  schedules: readonly LoadedSchedule[];
  /** Settles when every long connection is up — immediately when there are none. */
  ready: Promise<void>;
  /**
   * The control plane's bearer token and prefix, when `sessionControl` is on — how a caller hands access to a client.
   */
  control?: { token: string; prefix: string };
  /** Stop long connections and schedules. */
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
  /** Present iff this agent published a control plane. */
  sessionControl?: SessionControl;
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

  const routed = await routesFor(agentDir, agent, stateRoot, sessionControl, { builtinInvoke: true });
  const withControl = mountSessionControl(routed.routes, sessionControl, { agent });
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
            builtinInvoke: routed.builtinInvoke,
          },
          schedules: scheduled.schedules,
          ready,
          ...(withControl.control ? { control: withControl.control } : {}),
          close,
        };
      }).pipe(
        Scope.provide(lifetime),
        Effect.onError(() => rollback),
      );
    }),
  );
}
