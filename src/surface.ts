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
 * So the assembly lives here, once, and `dev`/`start` are two of its callers rather than its only
 * implementation.
 */
import type { Agent } from "./agent.ts";
import type { ChannelHandler, Routes } from "./channel.ts";
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
  /** Write `<stateRoot>/control.json` so a local client can find the plane, once the port is known.
   *  Only meaningful when `sessionControl` is on and the surface has its own port; an embedder
   *  mounted inside a larger app usually distributes the token another way. */
  announce(boundPort: number): void;
  /** Stop long connections and schedules. Idempotent; also runs when `options.signal` aborts. */
  close(): Promise<void>;
}

export interface OpenAgentSurfaceOptions {
  model?: string;
  authPath?: string;
  sessionsDir?: string;
  /** Aborting this closes the surface, exactly like calling {@link AgentSurface.close}. */
  signal?: AbortSignal;
  /** Called when a long connection ends on its own — a dropped socket-mode channel, say. The CLI
   *  exits; an embedded host may prefer to log. Default: log an error. */
  onChannelClosed?: (name: string, error?: unknown) => void;
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
  const { agent, agentDir, workspace, stateRoot, config, sessionControl } = opened;

  const routed = await routesFor(agentDir, agent, stateRoot, sessionControl, { builtinInvoke: true });
  const withControl = mountSessionControl(routed.routes, sessionControl, stateRoot, { agent });
  const scheduled = await startSchedules(agentDir, agent, stateRoot, config.selfSchedule ?? false);

  const abort = new AbortController();
  const onClosed =
    options.onChannelClosed ??
    ((name, error) =>
      log.error(`[fastagent] long connection ${name} ${error === undefined ? "closed" : `failed: ${String(error)}`}`));
  const runs = routed.longConnections.map((connection) => {
    const run = connection.connect(abort.signal);
    if (typeof run?.ready?.then !== "function" || typeof run?.closed?.then !== "function") {
      throw new Error(`${connection.name} connect(signal) must return { ready: Promise, closed: Promise }`);
    }
    void run.closed.then(
      () => {
        if (!abort.signal.aborted) onClosed(connection.name);
      },
      (error: unknown) => {
        if (!abort.signal.aborted) onClosed(connection.name, error);
      },
    );
    return run;
  });
  // Health answers 503 until EVERY long connection is up, so a load balancer does not route into a
  // surface whose socket-mode channels are still dialling. An abort before that settles `ready` as
  // cancellation, not readiness — a surface being torn down must not report itself healthy.
  void Promise.all(runs.map((run) => run.ready)).then(() => {
    if (!abort.signal.aborted) routed.markReady();
  });

  let closed: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closed ??= (async () => {
      abort.abort();
      scheduled.stop();
    })();
    return closed;
  };
  options.signal?.addEventListener("abort", () => void close(), { once: true });

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
    announce: withControl.announce,
    close,
  };
}
