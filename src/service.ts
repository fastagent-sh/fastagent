/**
 * The product, as one call: an agent directory becomes a live service.
 *
 * That phrase is the promise on the README, and until this existed only the CLI could keep it.
 * Everything else was parts: assemble the agent, discover channels, mount the control plane, start
 * schedules, open long connections, compose a router. An embedder had to know that list and get its
 * order right; getting it wrong is silent (a plane that 404s while advertising itself, a schedule
 * that never fires), and this repo has made that exact mistake in its own CLI.
 *
 * So the assembly lives here, and `dev`/`start` are callers. AgentCore is the one exception, and a
 * substantive one: its channels load lazily after a state-snapshot restore, so it cannot use an
 * assembly that discovers them eagerly (cli/commands/start.ts says so at the branch).
 */
import type { Agent } from "./agent.ts";
import type { ChannelHandler, LongConnection, Routes } from "./channel.ts";
import { type PrefixMount, router } from "./channels/serve.ts";
import { createPiAgentFromDir } from "./engines/pi/open.ts";
import { log } from "./log.ts";
import { mountSessionControl, routesFor, startSchedules } from "./cli/serve.ts";
import type { LoadedSchedule } from "./schedule/schedule.ts";

/** How long shutdown waits for a channel's `closed` before reporting it stuck. A channel that
 *  ignores its abort signal must not be able to hang a caller's teardown — or, during a failed
 *  start, keep the original error from ever arriving. */
const CLOSE_DEADLINE_MS = 5_000;

/** Settle when every connection has closed, or when the deadline passes. Returns the ones that did
 *  not close, so the caller can say which channel is stuck rather than just that something is. */
async function closeWithin(
  runs: readonly LongConnection[],
  names: readonly string[],
): Promise<{ stuck: string[]; failures: unknown[] }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcomes = await Promise.race([
      Promise.allSettled(runs.map((run) => run.closed)),
      // NOT unref'd: this timer is the thing being awaited, and an unref'd one lets the loop go
      // idle with nothing left to advance it. Cleared below so a prompt close does not hold the
      // process for the rest of the deadline.
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), CLOSE_DEADLINE_MS);
      }),
    ]);
    if (!outcomes) return { stuck: [...names], failures: [] };
    return {
      stuck: [],
      failures: outcomes.flatMap((o) => (o.status === "rejected" ? [o.reason] : [])),
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface AgentService {
  /** The assembled Fetch handler: channel routes, the control plane, and health. Mount it wherever
   *  your host speaks `(Request) => Response`; `nodeListener` bridges it to Node's `(req, res)`. */
  handler: ChannelHandler;
  /** The agent behind it — invoke it directly when you also want a programmatic path. */
  agent: Agent;
  /** The literal routes and prefix mounts `handler` was composed from. Present for a host that must
   *  re-wrap them (the AgentCore adapter does); an ordinary embedder wants `handler`. */
  routes: Routes;
  mounts: readonly PrefixMount[];
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
}

export interface CreateAgentServiceOptions extends MountAgentServiceOptions {
  model?: string;
  authPath?: string;
  sessionsDir?: string;
}

/**
 * Open an agent directory as a live service: one handler, mounted wherever you serve.
 *
 * ```ts
 * const service = await createAgentService("./my-agent");
 * app.use("/agent", nodeListener(service.handler));
 * ```
 */
export async function createAgentService(dir: string, options: CreateAgentServiceOptions = {}): Promise<AgentService> {
  const opened = await createPiAgentFromDir(dir, {
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.authPath !== undefined ? { authPath: options.authPath } : {}),
    ...(options.sessionsDir !== undefined ? { sessionsDir: options.sessionsDir } : {}),
    serving: true, // a mounted service is long-running: the scheduler poller runs
  });
  return mountAgentService(opened, options);
}

/** An already-opened directory — `createPiAgentFromDir`'s result. The CLI opens first so it can
 *  print its startup report, then mounts through the same assembly an embedder gets. */
export type OpenedAgentDir = Awaited<ReturnType<typeof createPiAgentFromDir>>;

/**
 * The assembly itself, over an already-opened directory: channels, the control plane, schedules and
 * long connections, composed into one handler.
 *
 * {@link createAgentService} is this plus opening the directory. `dev`/`start` open separately — their
 * startup report needs the opened values before anything mounts — and then arrive here, so there is
 * one assembly rather than one per caller.
 */
export async function mountAgentService(
  opened: OpenedAgentDir,
  options: MountAgentServiceOptions = {},
): Promise<AgentService> {
  const { agentDir, workspace, stateRoot, config, sessionControl } = opened;
  // Wrapped BEFORE anything consumes it: routes, the control plane and schedules must all drive the
  // same agent, so this is a hook rather than something a caller applies afterwards.
  const agent = options.wrapAgent?.(opened.agent) ?? opened.agent;

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
  const scheduled = await startSchedules(agentDir, agent, stateRoot, config.selfSchedule ?? false);

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
  // Rolled back on failure: a connection that throws while the ones before it are open, and the
  // scheduler already ticking, would otherwise leave both running behind a rejected open().
  const rollback = async (error: unknown): Promise<never> => {
    abort.abort();
    scheduled.stop();
    // Bounded and non-throwing: the original error is what the caller needs, so neither a connection
    // that failed to stop nor one that never stops may replace it or delay it forever.
    const { stuck, failures } = await closeWithin(
      runs,
      routed.longConnections.map((c) => c.name),
    );
    for (const failure of failures) {
      log.error(`[fastagent] cleanup after a failed start also failed: ${String(failure)}`);
    }
    if (stuck.length > 0) log.error(`[fastagent] did not stop within ${CLOSE_DEADLINE_MS}ms: ${stuck.join(", ")}`);
    throw error;
  };
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
      );
      if (stuck.length > 0) {
        throw new Error(`long connection(s) did not stop within ${CLOSE_DEADLINE_MS}ms: ${stuck.join(", ")}`);
      }
      if (failures.length > 0) {
        throw failures.length === 1 ? failures[0] : new AggregateError(failures, "long connections failed to close");
      }
    })();
    return closing;
  };
  // Detached by `close()`: a caller that closes services itself while holding one long-lived signal
  // would otherwise accumulate listeners, each pinning a whole service through its closure.
  // The signal path has no caller awaiting the promise, so a failure to stop would be an unhandled
  // rejection — in an embedded library, potentially the host's exit. Reported instead.
  const onAbort = () =>
    void close().catch((error: unknown) => log.error(`[fastagent] service close failed: ${String(error)}`));
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
    mounts: withControl.mounts,
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
