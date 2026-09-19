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
import { assertCorsOrigins, parseRouteKey, pathUnderPrefix, type PrefixMount, router } from "./channels/serve.ts";
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
  /**
   * The routes that AUTHENTICATE NOBODY — `POST /invoke` and `GET /health`, minus what a channel took over or
   * `http.invoke: false` withheld. Kept APART from the channels' rather than merged with a list of which keys are
   * which: three separate decisions read this (browser reachability, the JSON body gate, what the startup line
   * calls unauthenticated), and while it was a derived list each of them could answer differently.
   */
  unverified: Routes;
  /**
   * What the `channels/` files serve. Exempt from both guards because a channel checks its platform's signature
   * inside itself — an assumption about the author for a CUSTOM channel, not a property we enforce (§14).
   */
  selfVerifying: Routes;
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
  /**
   * `serveInvoke: false` withholds the data plane. Two callers, two reasons: the AgentCore adapter serves the
   * Runtime's `/invocations` contract instead, and an author sets `http.invoke: false` to leave the channels'
   * signature checks as the only way into a public port. Named for the config key it carries, not for the
   * "built-in fallback" it once withheld — that concept is gone.
   */
  options: { serveInvoke?: boolean } = {},
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
  /**
   * Which channel key already serves this path for the method a built-in would answer — the CHANNEL's spelling, not
   * ours. A channel may write the method-less `"/invoke"`, and an error naming `"POST /invoke"` sends its author
   * grepping their own file for a string that is not in it.
   */
  const covered = (path: string, method: string): string | undefined =>
    Object.keys(routes).find((key) => {
      const entry = parseRouteKey(key);
      return entry.path === path && (entry.method === undefined || entry.method === method);
    });
  let ready = longConnections.length === 0;
  const health = (): Response => (ready ? text("ok\n", 200) : text("starting\n", 503));
  // AgentCore serves the data plane through the Runtime's own `/invocations` contract, so the adapter opts out — and
  // with no `/invoke` of ours on that surface there is nothing to reserve, which is why the refusal is in here.
  const unverified: Routes = { ...(covered("/health", "GET") ? {} : { "GET /health": health }) };
  if (options.serveInvoke !== false) unverified["POST /invoke"] = createInvokeHandler(agent);
  // ONE rule over the whole table, so the next route we add is reserved by existing here rather than by someone
  // remembering to write a second check for it. `/health` is exempt by construction: it is only in `ours` when no
  // channel already serves it, because a probe is the deployment's to shape.
  const taken = Object.keys(unverified).flatMap((key) => {
    const entry = parseRouteKey(key);
    const channelKey = covered(entry.path, entry.method ?? "");
    return channelKey === undefined ? [] : [{ channelKey, key }];
  });
  if (taken.length > 0) {
    throw new Error(
      `channel route(s) ${taken.map((t) => `"${t.channelKey}"`).join(", ")} take a path this serve answers on ` +
        `itself (${taken.map((t) => `"${t.key}"`).join(", ")}) — rename the channel route`,
    );
  }
  return {
    unverified,
    selfVerifying: routes,
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
   * What actually mounted, for a startup line: channel files serving routes, and long connections.
   */
  channels: { routes: string[]; longConnections: string[] };
  /**
   * The route keys on this port that AUTHENTICATE NOBODY — `POST /invoke` and `GET /health`, minus what a channel
   * took over or `http.invoke: false` withheld. The FACT a caller needs to describe this surface: reading it off
   * `routes` instead answers a different question, since a channel may serve one of those paths with a protocol of
   * its own. That mistake ran in both directions here — a try-it curl for a route that 404s, and a warning about an
   * unauthenticated `/invoke` that was really a signature-checked channel.
   */
  unverifiedRoutes: readonly string[];
  /**
   * The cross-origin allow-list this service was assembled with (`http.cors`), or `undefined` for the `*` default.
   * Read by the startup report for the same reason as {@link AgentService.unverifiedRoutes}: what a caller says
   * about this surface must come from what was actually assembled, not from re-deriving it.
   */
  corsOrigins?: readonly string[];
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
  /**
   * The origins a browser may call this serve from (`http.cors`). Unset is the default, which answers EVERY origin
   * — see `channels/serve.ts`; setting this is the only way to narrow it, and an empty list is refused.
   */
  corsOrigins?: readonly string[];
  /**
   * Serve the data plane, `POST /invoke` (`http.invoke`; default true). The OFF switch for a deployment whose port
   * is public and whose channels' signature checks are meant to be the only way in — the route is unauthenticated
   * and runs a turn with the agent's full tool authority.
   */
  serveInvoke?: boolean;
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
  // The embedder's way in, checked like the config file's (`http.cors`): `allowedOrigin` compares exact strings, so
  // a stray trailing slash would refuse the front end with nothing naming the rule.
  if (opened.corsOrigins) assertCorsOrigins(opened.corsOrigins, "mountAgentService: corsOrigins");

  const routed = await routesFor(agentDir, agent, stateRoot, sessionControl, {
    ...(opened.serveInvoke !== undefined ? { serveInvoke: opened.serveInvoke } : {}),
  });
  const withControl = mountSessionControl(routed.selfVerifying, opened.publishControl ? sessionControl : undefined);
  // Composed BEFORE anything starts.
  const handler = router({
    unverified: routed.unverified,
    selfVerifying: withControl.routes,
    mounts: withControl.mounts,
    ...(opened.corsOrigins ? { corsOrigins: opened.corsOrigins } : {}),
  });
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
          routes: { ...routed.unverified, ...withControl.routes },
          agentDir,
          workspace,
          channels: {
            routes: routed.routeChannels,
            longConnections: names,
          },
          unverifiedRoutes: Object.keys(routed.unverified),
          ...(opened.corsOrigins ? { corsOrigins: opened.corsOrigins } : {}),
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
