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
import { mkdirSync, rmSync } from "node:fs";
import { writeFileAtomic } from "./atomic-write.ts";
import { join } from "node:path";
import type { Agent } from "./agent.ts";
import { classifyBind, clientHost } from "./bind.ts";
import { CONTROL_TOKEN_ENV, createControlPlane } from "./channels/control.ts";
import { createInvokeHandler } from "./channels/http.ts";
import { text } from "./channels/respond.ts";
import { parseRouteKey, pathUnderPrefix } from "./channels/serve.ts";
import { type LoadedLongConnectionChannel, loadChannels } from "./channels/discover.ts";
import { loadSchedules } from "./schedule/discover.ts";
import { createScheduler } from "./schedule/scheduler.ts";
import type { SessionControl } from "./session.ts";
import type { ChannelHandler, LongConnection, Routes } from "./channel.ts";
import { type PrefixMount, router } from "./channels/serve.ts";
import { log, reportModuleLoadFailures } from "./log.ts";
import type { LoadedSchedule } from "./schedule/schedule.ts";

/** Default wait for a channel's `closed` before reporting it stuck. A channel that ignores its
 *  abort signal must not hang a caller's teardown — or, during a failed start, keep the original
 *  error from arriving. The CLI passes a shorter one: its own forced exit must come AFTER this, or
 *  the process leaves at 0 before the failure is known. */
const CLOSE_DEADLINE_MS = 5_000;

/** Settle when every connection has closed, or when the deadline passes. Reports the ones that did
 *  NOT settle — named individually, so a single stuck channel is not reported as all of them. */
async function closeWithin(
  runs: readonly LongConnection[],
  names: readonly string[],
  deadlineMs: number,
): Promise<{ stuck: string[]; failures: unknown[] }> {
  const pending = new Set(runs.map((_, i) => i));
  const failures: unknown[] = [];
  const tracked = runs.map((run, i) =>
    run.closed.then(
      () => {
        pending.delete(i);
      },
      (error: unknown) => {
        pending.delete(i);
        failures.push(error);
      },
    ),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(tracked),
      // NOT unref'd: this timer is the thing being awaited, and an unref'd one lets the loop go
      // idle with nothing left to advance it. Cleared below so a prompt close does not hold the
      // process for the rest of the deadline.
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, deadlineMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  return { stuck: [...pending].map((i) => names[i] ?? "channel"), failures };
}

export interface ServingSurface {
  routes: Routes;
  /** Prefix-owning handlers mounted beside the routes (the session control plane). */
  mounts?: readonly PrefixMount[];
  longConnections: LoadedLongConnectionChannel[];
  /** Route-channel basenames; the tunnel registers only this subset. */
  routeChannels: string[];
  builtinInvoke: boolean;
  /** Marks the built-in health route ready after every long-connection channel first connects. */
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
    console.error(
      `[fastagent] warn: channel route "${c.route}" (${c.source}) collides with an earlier channel — not mounted`,
    );
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
  stateRoot: string,
  options: { tunnel?: boolean; agent?: Agent; host?: string } = {},
): {
  routes: Routes;
  mounts: PrefixMount[];
  /** The plane's bearer token and prefix — how an embedder distributes access without a discovery file. */
  control?: { token: string; prefix: string };
  /** Write the local discovery file; returns its removal. Installs no signal handlers. */
  announce: (boundPort: number) => () => void;
} {
  if (!control) return { routes, mounts: [], announce: () => () => {} };
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
        "/control/* (steer/abort/set_model) and anyone who can reach the port; use a random value (uuidgen)",
    );
  }
  const token = injected || crypto.randomUUID();
  const plane = createControlPlane(control, { token, agent: options.agent });
  assertNoControlPlaneCollision(routes, plane);
  return {
    routes,
    mounts: [plane],
    control: { token, prefix: plane.prefix },
    // Writes the discovery file and hands back its removal. It installs NO signal handlers: a
    // library mounted inside someone's app must not change how that app exits — the CLI wires the
    // returned cleanup into its own shutdown, an embedder into `close()`.
    announce: (boundPort) => {
      mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
      const path = join(stateRoot, "control.json");
      const url = `http://${clientHost(options.host)}:${boundPort}`;
      writeFileAtomic(path, `${JSON.stringify({ url, token })}\n`, 0o600);
      log.info(`[fastagent] session control on /control/* (token in ${path})`);
      // LAN-reachable with the bearer token as the only protection — the tunnel and deploy paths
      // warn loudly, and the LAN path must not be the silent third way past the local trust story.
      // A loopback bind closes exactly that reach, so it earns silence.
      const bind = classifyBind(options.host);
      if (bind !== "loopback") {
        log.warn(
          `[fastagent] the port binds ${bind === "wildcard" ? "all interfaces" : `${options.host} (off this machine)`}: ` +
            "/control/* is reachable on your LAN, protected only by the bearer token — bind loopback " +
            "(--bind 127.0.0.1), firewall the port, or wrap it for real exposure (docs: design §14)",
        );
      }
      if (options.tunnel) {
        // Local trust = the token + its file permissions; --tunnel takes the whole port PUBLIC.
        log.warn(
          "[fastagent] --tunnel exposes /control/* (steer/abort/set_model) at the public tunnel URL, " +
            "protected ONLY by the bearer token — wrap it with real auth before sharing that URL (docs: design §14)",
        );
      }
      // Removed on shutdown so a stale file cannot point a client at a dead port: `attach` then
      // fails with "cannot read" (accurate) instead of a stale token's misleading 401/ECONNREFUSED.
      return () => {
        try {
          rmSync(path, { force: true });
        } catch {
          /* the file is advisory — shutdown must not fail on it */
        }
      };
    },
  };
}

/**
 * Load and start the agent's `schedules/` — a time-trigger firing the agent on each cron. Starts iff
 * there are static schedules OR `selfSchedule` is on. Best-effort stop on process signals. Returns the
 * loaded schedules so a serving surface that needs them (the AgentCore adapter's fire binding) shares
 * ONE load instead of re-discovering. `externalClock` (AgentCore) arms no resident cron timers.
 */
export async function startSchedules(
  agentDir: string,
  agent: Agent,
  stateRoot: string,
  selfSchedule: boolean,
  options: { externalClock?: boolean } = {},
): Promise<{ schedules: LoadedSchedule[]; stop: () => void }> {
  // Thrown, not exited on: this runs inside an embedder's app as well as the CLI, and a library
  // that calls process.exit takes a decision (degrade? retry? stop?) that belongs to its host. The
  // CLI catches at its own boundary.
  const { schedules, failures } = await loadSchedules(agentDir);
  reportModuleLoadFailures(failures);
  if (schedules.length === 0 && !selfSchedule) return { schedules, stop: () => {} };
  const scheduler = createScheduler({ agent, stateRoot, schedules, externalClock: options.externalClock });
  scheduler.start();
  if (schedules.length > 0) {
    log.info(
      `[fastagent] schedules: ${schedules.map((s) => s.name).join(", ")}${options.externalClock ? " (external clock — no resident cron timers)" : ""}`,
    );
  }
  // Returned rather than bound to process signals here: this runs inside an embedder's app as well
  // as the CLI, and a library that installs SIGINT handlers is deciding something that is not its
  // to decide. `runStart`/`runDev` wire it to their own shutdown.
  return { schedules, stop: () => scheduler.stop() };
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
  /** The control plane's bearer token and prefix, when `sessionControl` is on — how an embedder
   *  hands access to a client without a discovery file. */
  control?: { token: string; prefix: string };
  /** Write `<stateRoot>/control.json` so a LOCAL client (`fastagent attach`) can find the plane,
   *  once the port is known. Optional: an embedder mounted inside a larger app has no port of its
   *  own to describe and uses {@link AgentService.control} instead.
   *
   *  Removed by `close()`. Not by an `exit` handler: installing one is a decision about the whole
   *  process, which a mounted library does not get to make. A hard exit therefore leaves the file
   *  behind — advisory, overwritten by the next boot, and the client's own error stays honest. */
  announce(boundPort: number): void;
  /** Stop long connections and schedules. Idempotent; also runs when `options.signal` aborts. */
  close(): Promise<void>;
}

/** What {@link mountAgentService} needs beyond an opened directory. */
export interface MountAgentServiceOptions {
  /** Wrap the agent before anything consumes it — every consumer (routes, control plane, schedules)
   *  must get the SAME one, which is why this is a hook rather than the caller's own call. `dev`
   *  passes `logAgentLoop`. */
  wrapAgent?: (agent: Agent) => Agent;
  /** Passed through to the control plane mount: `--tunnel` widens its warning, `host` names the
   *  bind address in the discovery file. */
  control?: { tunnel?: boolean; host?: string };
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
  const withControl = mountSessionControl(routed.routes, sessionControl, stateRoot, {
    agent,
    ...(options.control?.tunnel !== undefined ? { tunnel: options.control.tunnel } : {}),
    ...(options.control?.host !== undefined ? { host: options.control.host } : {}),
  });
  // Composed BEFORE anything starts. `router` re-validates what `loadChannels` and the control
  // mount already checked, so on THIS path it should not fail — but "should not" is not an ordering
  // guarantee, and a throw after the scheduler ticks and channels dial would leave both running
  // with no service for the caller to close. Free to order correctly; expensive to discover later.
  const handler = router(withControl.routes, withControl.mounts);
  const scheduled = await startSchedules(agentDir, agent, stateRoot, opened.selfSchedule);

  const abort = new AbortController();
  let unannounce: (() => void) | undefined;
  // A connection that drops while others are still dialling must not be undone by their later
  // readiness: the service is missing a declared channel from that moment on, whatever else arrives.
  let dropped = false;
  const onClosed =
    options.onChannelClosed ??
    ((name, error) =>
      log.error(`[fastagent] long connection ${name} ${error === undefined ? "closed" : `failed: ${String(error)}`}`));
  const runs: LongConnection[] = [];

  // A FUNCTION declaration, not a const: `close()` detaches this listener, and a rollback can call
  // `close()` before this point is reached — a `const` would be in its temporal dead zone there, so
  // the cleanup would throw a ReferenceError and silently skip everything after it.
  //
  // Detached because a caller that closes services itself while holding one long-lived signal would
  // otherwise accumulate listeners, each pinning a whole service through its closure. The signal
  // path has no caller awaiting the promise, so a failure to stop is reported rather than left as an
  // unhandled rejection — in an embedded library, potentially the host's exit.
  function onAbort(): void {
    void close().catch((error: unknown) => log.error(`[fastagent] service close failed: ${String(error)}`));
  }

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    // Awaits the connections rather than only signalling them: `close()` promises they are stopped,
    // and a caller tearing down a test or a request-scoped service needs that to be true on return.
    closing ??= (async () => {
      abort.abort();
      scheduled.stop();
      options.signal?.removeEventListener("abort", onAbort);
      unannounce?.(); // a stale discovery file would point a client at a dead port
      // A failure to stop is the caller's to know about — swallowing it would let `close()` report
      // success over a channel still holding on. Bounded, because a channel that ignores its abort
      // signal must not hang the teardown either.
      const { stuck, failures } = await closeWithin(
        runs,
        routed.longConnections.map((c) => c.name),
        closeTimeoutMs,
      );
      if (stuck.length > 0) {
        throw new Error(`long connection(s) did not stop within ${closeTimeoutMs}ms: ${stuck.join(", ")}`);
      }
      if (failures.length > 0) {
        throw failures.length === 1 ? failures[0] : new AggregateError(failures, "long connections failed to close");
      }
    })();
    return closing;
  };

  // Rollback IS close(), plus keeping the original error: a failure to clean up is the aftermath,
  // and replacing the reason the caller needs with it hides the actual cause.
  const rollback = async (error: unknown): Promise<never> => {
    await close().catch((closeError: unknown) =>
      log.error(`[fastagent] cleanup after a failed start also failed: ${String(closeError)}`),
    );
    throw error;
  };
  // Rolled back on failure: a connection that throws while the ones before it are open, and the
  // scheduler already ticking, would otherwise leave both running behind a rejected open().
  for (const connection of routed.longConnections) {
    let run: LongConnection;
    try {
      run = connection.connect(abort.signal);
    } catch (error) {
      return rollback(error);
    }
    if (typeof run?.ready?.then !== "function" || typeof run?.closed?.then !== "function") {
      return rollback(new Error(`${connection.name} connect(signal) must return { ready: Promise, closed: Promise }`));
    }
    void run.closed.then(
      () => {
        if (abort.signal.aborted) return;
        // A channel that dies leaves the service serving something it no longer has.
        dropped = true;
        routed.setReady(false);
        onClosed(connection.name);
      },
      (error: unknown) => {
        if (abort.signal.aborted) return;
        dropped = true;
        routed.setReady(false);
        onClosed(connection.name, error);
      },
    );
    runs.push(run);
  }

  if (options.signal?.aborted) await close();
  else options.signal?.addEventListener("abort", onAbort, { once: true });

  // Health answers 503 until EVERY long connection is up, so a load balancer does not route into a
  // service whose socket-mode channels are still dialling. An abort before that settles `ready` as
  // cancellation, not readiness — a service being torn down must not report itself healthy.
  const ready = (async () => {
    try {
      await Promise.all(
        runs.map(async (run, i) => {
          const name = routed.longConnections[i]?.name ?? "channel";
          // Raced against `closed`, because the contract puts a terminal failure THERE: a channel
          // that dies dialling may leave `ready` pending forever, and waiting on it alone hangs
          // startup with no diagnosis.
          await Promise.race([
            run.ready,
            run.closed.then(
              () => Promise.reject(new Error(`${name} closed before it was ready`)),
              (error: unknown) => Promise.reject(new Error(`${name} failed before it was ready: ${String(error)}`)),
            ),
          ]);
          if (!abort.signal.aborted) log.info(`[fastagent] long connection ready: ${name}`);
        }),
      );
    } catch (error) {
      // A connection that cannot come up is a startup failure, not a degraded service: tear the rest
      // down before rejecting, so nothing is left running behind a caller that saw an error. A
      // cleanup that ALSO fails is logged, never rethrown — it would replace the reason the caller
      // actually needs with the aftermath of it.
      await close().catch((closeError: unknown) =>
        log.error(`[fastagent] cleanup after a failed start also failed: ${String(closeError)}`),
      );
      throw error;
    }
    // A `ready` that settles because the service was CLOSED is cancellation, not readiness — the
    // contract lets a connection resolve it on abort. Returning normally would tell a caller its
    // channels are up while the service is shut and health says 503.
    if (abort.signal.aborted) throw new Error("service closed before it became ready");
    // A drop DURING startup fails it. `dropped` is only reachable here from the startup window —
    // after this line `ready` has settled — and resolving while health is permanently 503 would
    // hand the caller two contradictory answers about the same surface.
    if (dropped) {
      await close();
      throw new Error("a long connection closed before startup completed");
    }
    routed.setReady(true);
  })();
  // Observed here so a rejection is never unhandled; every caller still sees it through `ready`.
  ready.catch(() => {});

  return {
    handler,
    agent,
    routes: withControl.routes,
    agentDir,
    workspace,
    channels: {
      routes: routed.routeChannels,
      longConnections: routed.longConnections.map((c) => c.name),
      builtinInvoke: routed.builtinInvoke,
    },
    schedules: scheduled.schedules,
    ready,
    ...(withControl.control ? { control: withControl.control } : {}),
    announce: (boundPort) => {
      unannounce = withControl.announce(boundPort);
    },
    close,
  };
}
