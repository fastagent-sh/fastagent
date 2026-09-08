/**
 * The product, as one call: an agent directory becomes a live service.
 *
 * That phrase is the promise on the README, and until this existed only the CLI could keep it. The
 * assembly parts live here too — `routesFor`, `mountSessionControl`, `startSchedules` — because a
 * public entry may not reach into `cli/`: that directory decides process-level things (`fail.ts`
 * calls `process.exit`) which a library mounted inside someone's app does not get to decide.
 * Everything else was parts: assemble the agent, discover channels, mount the control plane, start
 * schedules, open long connections, compose a router. An embedder had to know that list and get its
 * order right, and getting it wrong is silent: a plane that 404s while advertising itself, a
 * schedule that never fires.
 *
 * So the assembly lives here, and `dev`/`start` are callers. AgentCore is the one exception, and a
 * substantive one: its channels load lazily after a state-snapshot restore, so it cannot use an
 * assembly that discovers them eagerly (cli/commands/start.ts says so at the branch).
 */
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

/** Default wait for a channel's `closed` before reporting it stuck. A channel that ignores its
 *  abort signal must not hang a caller's teardown — or, during a failed start, keep the original
 *  error from arriving. The CLI passes a shorter one: its own forced exit must come AFTER this, or
 *  the process leaves at 0 before the failure is known. */
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
  /** Flip health between 200 and 503. Two-way on purpose: a long connection that dies after coming
   *  up leaves the surface serving something it no longer has, and a load balancer should hear it. */
  setReady(value: boolean): void;
}

/**
 * The surface this deployment serves: default `GET /health` plus discovered channels, or the default
 * POST `/invoke` only when neither a route nor a long-connection channel was declared.
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

/**
 * Refuse channel routes the control plane would swallow.
 *
 * `router` refuses this too, and would catch it a moment later; this exists for the sentence, not
 * the check — an author who lands a route under `/control` needs to hear about `sessionControl`,
 * which the host has no way to mention. Both ask {@link pathUnderPrefix}, so there is one rule with
 * two wordings, not two rules.
 *
 * Called from BOTH mount points: here at boot, and again on agentcore's lazy path, whose channels
 * load after this ran against an empty base.
 */
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
  /** The plane's bearer token and prefix — how a caller distributes access (the CLI writes it to
   *  `<stateRoot>/control.json` for local discovery; an embedder hands it out itself). */
  control?: { token: string; prefix: string };
} {
  if (!control) return { routes, mounts: [] };
  // WHO OWNS the secret. Per-boot mint is right locally: discovery is `control.json` and its file
  // permissions, which works because both holders share a filesystem. A deployment removes that
  // premise — a token minted in the container is replaced every restart and reachable only by shelling
  // in — so there the deployer mints it and injects it here, like the wake/ingress secrets.
  // Trimmed on read, like `.env` values already are: a token pasted from a dashboard with a trailing
  // newline would otherwise become the box's token verbatim, and every caller holding the clean value
  // gets a bare 401 — the undiagnosable symptom, one character wide.
  const injected = process.env[CONTROL_TOKEN_ENV]?.trim();
  // SET BUT EMPTY is the deployed default, not an edge case: the generated Compose topology writes
  // every secret as `NAME: "${NAME:-}"`, so an operator who skipped this one lands here. Falling back
  // silently would leave exactly the symptom the injection exists to remove — a token the caller does
  // not have — with nothing in the log to tell it apart from a deployment that never asked.
  if (injected === "") {
    log.warn(
      `[fastagent] ${CONTROL_TOKEN_ENV} is set but empty — minting a per-boot token instead; callers holding ` +
        "the deploy-time value will get 401 (set it, or read the minted one from control.json on the box)",
    );
  } else if (injected !== undefined && injected.length < 16) {
    // Length is a crude proxy for entropy — sixteen `a`s pass. It is aimed at `changeme`, which this
    // change makes newly dangerous: the plane went from unusable-in-a-deployment to usable by whoever
    // holds this string, and the empty case is the only other thing that says anything.
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

/**
 * Load and start the agent's `schedules/` — a time-trigger firing the agent on each cron. Starts iff
 * there are static schedules OR `selfSchedule` is on. Best-effort stop on process signals. Returns the
 * loaded schedules so a serving surface that needs them (the AgentCore adapter's fire binding) shares
 * ONE load instead of re-discovering. `externalClock` (AgentCore) arms no resident cron timers.
 */
export async function startSchedules(
  ...args: Parameters<typeof prepareSchedules>
): Promise<{ schedules: LoadedSchedule[]; stop: () => void }> {
  const scheduled = await prepareSchedules(...args);
  scheduled.start();
  return { schedules: scheduled.schedules, stop: scheduled.stop };
}

/** Load definitions without reading execution state; AgentCore starts polling only after restore. */
export async function prepareSchedules(
  agentDir: string,
  agent: Agent,
  stateRoot: string,
  selfSchedule: boolean,
  options: { externalClock?: boolean } = {},
): Promise<{ schedules: LoadedSchedule[]; start: () => void; stop: () => void }> {
  // Thrown, not exited on: this runs inside an embedder's app as well as the CLI, and a library
  // that calls process.exit takes a decision (degrade? retry? stop?) that belongs to its host. The
  // CLI catches at its own boundary.
  const { schedules, failures } = await loadSchedules(agentDir);
  reportModuleLoadFailures(failures);
  if (schedules.length === 0 && !selfSchedule) return { schedules, start: () => {}, stop: () => {} };
  const scheduler = Effect.runSync(
    createScheduler({ agent, stateRoot, schedules, externalClock: options.externalClock }),
  );
  return {
    schedules,
    start() {
      scheduler.start();
      if (schedules.length > 0) {
        log.info(
          `[fastagent] schedules: ${schedules.map((s) => s.name).join(", ")}${options.externalClock ? " (external clock — no resident cron timers)" : ""}`,
        );
      }
    },
    stop: () => scheduler.stop(),
  };
}

export interface AgentService {
  /** The assembled Fetch handler: channel routes, the control plane, and health. Mount it wherever
   *  your host speaks `(Request) => Response`; `nodeListener` bridges it to Node's `(req, res)`. */
  handler: ChannelHandler;
  /** The agent behind it — invoke it directly when you also want a programmatic path. */
  agent: Agent;
  /** The literal routes `handler` was composed from — for a startup line naming what is served.
   *  Mounted prefixes are not here: nothing outside the assembly needed them, and a field kept for a
   *  hypothetical caller is a field nobody maintains. */
  routes: Routes;
  agentDir: string;
  workspace: string;
  /** What actually mounted, for a startup line: channel files serving routes, long connections, and
   *  whether the built-in `POST /invoke` fallback is one of the routes. That last one is a FACT of
   *  the assembly, not something to re-infer from a path — a channel may legally author
   *  `POST /invoke` with a protocol of its own. */
  channels: { routes: string[]; longConnections: string[]; builtinInvoke: boolean };
  schedules: readonly LoadedSchedule[];
  /** Settles when every long connection is up — immediately when there are none. REJECTS if one
   *  fails to come up, after closing the service: a host must not report itself serving while a
   *  declared channel is dead, and health answers 503 until this resolves. */
  ready: Promise<void>;
  /** The control plane's bearer token and prefix, when `sessionControl` is on — how a caller hands
   *  access to a client. The CLI writes it to `<stateRoot>/control.json` for `fastagent attach`; an
   *  embedder mounted inside a larger app has no port of its own to describe and distributes it
   *  itself. */
  control?: { token: string; prefix: string };
  /** Stop long connections and schedules. Idempotent; also runs when `options.signal` aborts. */
  close(): Promise<void>;
}

/** What {@link mountAgentService} needs beyond an opened directory. */
export interface MountAgentServiceOptions {
  /** Wrap the agent before anything consumes it — every consumer (routes, control plane, schedules)
   *  must get the SAME one, which is why this is a hook rather than the caller's own call. `dev`
   *  passes `logAgentLoop`. */
  wrapAgent?: (agent: Agent) => Agent;
  /** Aborting this closes the service, exactly like calling {@link AgentService.close}. */
  signal?: AbortSignal;
  /** Called when a long connection ends on its own — a dropped socket-mode channel, say. The CLI
   *  exits; an embedded host may prefer to log. Default: log an error. */
  onChannelClosed?: (name: string, error?: unknown) => void;
  /** How long `close()` waits for a channel to stop before reporting it stuck (default 5s). The CLI
   *  shortens it so its own forced exit lands after this answer, not before it. */
  closeTimeoutMs?: number;
}

/**
 * What the assembly needs from an opened agent directory — the whole of it. Spelled as its own type
 * rather than an engine's return shape: every field here is either the SPEC contract or a path, so
 * an engine that is not pi can satisfy it without either side knowing about the other.
 */
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
  /** Whether the agent schedules its own follow-up turns. REQUIRED, not optional-with-a-default:
   *  an engine that forgot it would turn self-scheduling off silently, which is exactly the bug
   *  this type was introduced with. */
  selfSchedule: boolean;
}

/**
 * The assembly itself, over an already-opened directory: channels, the control plane, schedules and
 * long connections, composed into one handler.
 *
 * {@link createAgentService} is this plus opening the directory. `dev`/`start` open separately — their
 * startup report needs the opened values before anything mounts — and then arrive here, so there is
 * one assembly rather than one per caller.
 */
export async function mountAgentService(
  opened: MountableAgent,
  options: MountAgentServiceOptions = {},
): Promise<AgentService> {
  const { agentDir, workspace, stateRoot, sessionControl } = opened;
  // Wrapped BEFORE anything consumes it: routes, the control plane and schedules must all drive the
  // same agent, so this is a hook rather than something a caller applies afterwards.
  const agent = options.wrapAgent?.(opened.agent) ?? opened.agent;
  const closeTimeoutMs = options.closeTimeoutMs ?? CLOSE_DEADLINE_MS;

  const routed = await routesFor(agentDir, agent, stateRoot, sessionControl, { builtinInvoke: true });
  const withControl = mountSessionControl(routed.routes, sessionControl, { agent });
  // Composed BEFORE anything starts. `router` re-validates what `loadChannels` and the control
  // mount already checked, so on THIS path it should not fail — but "should not" is not an ordering
  // guarantee, and a throw after the scheduler ticks and channels dial would leave both running
  // with no service for the caller to close. Free to order correctly; expensive to discover later.
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

      // Scope.close alone does not join concurrent closes or retain their failure. Cache the whole
      // shutdown so every caller waits for the same result, including startup rollback.
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
        // Finalizers have no typed error channel; a close failure must reject the public Promise.
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

        // The public readiness waiter lives outside the scope it may roll back. Its source fibers
        // belong to the service, so closing also releases waits on an uncooperative channel.
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
