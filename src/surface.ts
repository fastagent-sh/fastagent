/**
 * The product, as one call: an agent directory becomes a mounted HTTP surface.
 *
 * fastagent's promise is "turn a file-defined agent into a live service INSIDE AN APP" — and until
 * this existed, only the CLI could keep it. Everything else was parts: assemble the agent, discover
 * channels, mount the control plane, start schedules, open long connections, compose a router. An
 * embedder had to know that list and get its order right; getting it wrong is silent (a plane that
 * 404s while advertising itself, a schedule that never fires), and this repo has made that exact
 * mistake in its own CLI.
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

export interface AgentSurface {
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
  /** What actually mounted, for a startup line: channel files serving routes, and long connections. */
  channels: { routes: string[]; longConnections: string[] };
  schedules: readonly LoadedSchedule[];
  /** Settles when every long connection is up — immediately when there are none. REJECTS if one
   *  fails to come up, after closing the surface: a host must not report itself serving while a
   *  declared channel is dead, and health answers 503 until this resolves. */
  ready: Promise<void>;
  /** The control plane's bearer token and prefix, when `sessionControl` is on — how an embedder
   *  hands access to a client without a discovery file. */
  control?: { token: string; prefix: string };
  /** Write `<stateRoot>/control.json` so a LOCAL client (`fastagent attach`) can find the plane,
   *  once the port is known. Optional: an embedder mounted inside a larger app has no port of its
   *  own to describe and uses {@link AgentSurface.control} instead.
   *
   *  Removed by `close()`. Not by an `exit` handler: installing one is a decision about the whole
   *  process, which a mounted library does not get to make. A hard exit therefore leaves the file
   *  behind — advisory, overwritten by the next boot, and the client's own error stays honest. */
  announce(boundPort: number): void;
  /** Stop long connections and schedules. Idempotent; also runs when `options.signal` aborts. */
  close(): Promise<void>;
}

/** What {@link mountAgentSurface} needs beyond an opened directory. */
export interface MountAgentSurfaceOptions {
  /** Wrap the agent before anything consumes it — every consumer (routes, control plane, schedules)
   *  must get the SAME one, which is why this is a hook rather than the caller's own call. `dev`
   *  passes `logAgentLoop`. */
  wrapAgent?: (agent: Agent) => Agent;
  /** Passed through to the control plane mount: `--tunnel` widens its warning, `host` names the
   *  bind address in the discovery file. */
  control?: { tunnel?: boolean; host?: string };
  /** Aborting this closes the surface, exactly like calling {@link AgentSurface.close}. */
  signal?: AbortSignal;
  /** Called when a long connection ends on its own — a dropped socket-mode channel, say. The CLI
   *  exits; an embedded host may prefer to log. Default: log an error. */
  onChannelClosed?: (name: string, error?: unknown) => void;
}

export interface OpenAgentSurfaceOptions extends MountAgentSurfaceOptions {
  model?: string;
  authPath?: string;
  sessionsDir?: string;
}

/**
 * Open an agent directory as an HTTP surface.
 *
 * ```ts
 * const surface = await openAgentSurface("./my-agent");
 * app.use("/agent", nodeListener(surface.handler));
 * ```
 */
export async function openAgentSurface(dir: string, options: OpenAgentSurfaceOptions = {}): Promise<AgentSurface> {
  const opened = await createPiAgentFromDir(dir, {
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.authPath !== undefined ? { authPath: options.authPath } : {}),
    ...(options.sessionsDir !== undefined ? { sessionsDir: options.sessionsDir } : {}),
    serving: true, // a mounted surface is long-running: the scheduler poller runs
  });
  return mountAgentSurface(opened, options);
}

/** An already-opened directory — `createPiAgentFromDir`'s result. The CLI opens first so it can
 *  print its startup report, then mounts through the same assembly an embedder gets. */
export type OpenedAgentDir = Awaited<ReturnType<typeof createPiAgentFromDir>>;

/**
 * The assembly itself, over an already-opened directory: channels, the control plane, schedules and
 * long connections, composed into one handler.
 *
 * {@link openAgentSurface} is this plus opening the directory. `dev`/`start` open separately — their
 * startup report needs the opened values before anything mounts — and then arrive here, so there is
 * one assembly rather than one per caller.
 */
export async function mountAgentSurface(
  opened: OpenedAgentDir,
  options: MountAgentSurfaceOptions = {},
): Promise<AgentSurface> {
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
  const scheduled = await startSchedules(agentDir, agent, stateRoot, config.selfSchedule ?? false);

  const abort = new AbortController();
  let unannounce: (() => void) | undefined;
  // A connection that drops while others are still dialling must not be undone by their later
  // readiness: the surface is missing a declared channel from that moment on, whatever else arrives.
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
    await Promise.allSettled(runs.map((run) => run.closed));
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
        // A channel that dies leaves the surface serving something it no longer has.
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
    // and a caller tearing down a test or a request-scoped surface needs that to be true on return.
    closing ??= (async () => {
      abort.abort();
      scheduled.stop();
      unannounce?.(); // a stale discovery file would point a client at a dead port
      await Promise.allSettled(runs.map((run) => run.closed));
    })();
    return closing;
  };
  if (options.signal?.aborted) await close();
  else options.signal?.addEventListener("abort", () => void close(), { once: true });

  // Health answers 503 until EVERY long connection is up, so a load balancer does not route into a
  // surface whose socket-mode channels are still dialling. An abort before that settles `ready` as
  // cancellation, not readiness — a surface being torn down must not report itself healthy.
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
      // A connection that cannot come up is a startup failure, not a degraded surface: tear the rest
      // down before rejecting, so nothing is left running behind a caller that saw an error.
      await close();
      throw error;
    }
    if (!abort.signal.aborted && !dropped) routed.setReady(true);
  })();
  // Observed here so a rejection is never unhandled; every caller still sees it through `ready`.
  ready.catch(() => {});

  return {
    handler: router(withControl.routes, withControl.mounts),
    agent,
    routes: withControl.routes,
    mounts: withControl.mounts,
    agentDir,
    workspace,
    channels: {
      routes: routed.routeChannels,
      longConnections: routed.longConnections.map((c) => c.name),
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
