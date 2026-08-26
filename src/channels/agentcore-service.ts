/**
 * The AgentCore serving assembly — the same product as `mountAgentService`, built differently
 * because the host is.
 *
 * Two facts drive every difference. There is no public URL (the adapter's `POST /invocations` is the
 * only ingress, and cron slots arrive through it from an external clock, so no resident timers), and
 * **the state mount at boot is PRE-RESTORE** — empty after every version update. Discovering channels
 * eagerly would therefore cache that emptiness (thread participation, delivery dedup, pending turns)
 * and then clobber the restored files with it, so channels are constructed lazily on the first
 * envelope. Everywhere else the state root is durable at boot and a broken channel fails startup.
 *
 * That is a different assembly, not a flag on the shared one: handler shape, discovery timing, clock
 * source, long-connection support and shutdown all differ. What it is NOT is a different product —
 * it returns the same {@link AgentService}, so `start` picks an assembly once and everything after
 * that point is common.
 */
import type { Agent } from "../agent.ts";
import { log } from "../log.ts";
import type { Routes } from "../channel.ts";
import type { LoadedSchedule } from "../schedule/schedule.ts";
import { fireScheduleOnce } from "../schedule/scheduler.ts";
import {
  type AgentService,
  type OpenedAgentDir,
  assertNoControlPlaneCollision,
  mountSessionControl,
  routesFor,
  startSchedules,
} from "../service.ts";
import { type RouteSurface, UnknownScheduleError, agentcoreRoutes } from "./agentcore.ts";
import { createStateSync } from "./agentcore-state.ts";
import { activeWork } from "./busy.ts";
import { routeKeysConflict, router } from "./serve.ts";

export interface MountAgentcoreServiceOptions {
  /** Wrap the opened agent before anything binds to it (the CLI's turn trace). */
  wrapAgent?: (agent: Agent) => Agent;
  /** Runs once the state snapshot is restored. The wake-alarm reconcile passes through here because
   *  its sink is a PROCESS-global: the process entry owns that, not a service that can be closed. */
  onStateReady?: () => void;
  control?: { tunnel?: boolean; host?: string };
}

/** Is this process running inside the AgentCore Runtime? Set by the generated deploy artifacts. */
export function isAgentcoreRuntime(): boolean {
  return process.env.FASTAGENT_AGENTCORE === "1";
}

export async function mountAgentcoreService(
  opened: OpenedAgentDir,
  options: MountAgentcoreServiceOptions = {},
): Promise<AgentService> {
  const { agentDir, workspace, stateRoot, config, sessionControl } = opened;
  const agent = options.wrapAgent?.(opened.agent) ?? opened.agent;

  // The control plane mounts over an EMPTY route surface: the lazy channels join it later, and the
  // collision rule runs again then (below) against what they actually brought.
  const withControl = mountSessionControl({}, sessionControl, stateRoot, { ...options.control, agent });

  const scheduled = await startSchedules(agentDir, agent, stateRoot, config.selfSchedule ?? false, {
    externalClock: true,
  });

  const lazyChannels = async (): Promise<RouteSurface> => {
    const lazy = await routesFor(agentDir, agent, stateRoot, sessionControl, { builtinInvoke: false });
    if (lazy.longConnections.length > 0) {
      throw new Error(
        `long-connection channel(s) ${lazy.longConnections.map((c) => c.name).join(", ")} cannot serve on ` +
          `AgentCore (scale-to-zero severs resident connections) — use the channel's webhook form`,
      );
    }
    // The SAME rule mountSessionControl applies, through the same function: its check ran against an
    // empty base at boot, so it has to run again once the channels are real.
    for (const plane of withControl.mounts) assertNoControlPlaneCollision(lazy.routes, plane);
    return { routes: lazy.routes, mounts: withControl.mounts };
  };

  // The adapter registers process-global listeners; this is what takes them down on close.
  const closed = new AbortController();
  const adapterRoutes = mountAgentcore(
    {},
    {
      signal: closed.signal,
      agent,
      stateRoot,
      schedules: scheduled.schedules,
      onStateReady: options.onStateReady,
      lazyChannels,
    },
  );
  const handler = router(adapterRoutes, withControl.mounts);
  log.info(`[fastagent] agentcore: serving POST /invocations + GET /ping (FASTAGENT_AGENTCORE=1)`);

  let unannounce: (() => void) | undefined;
  return {
    handler,
    agent,
    // The adapter IS the surface here; the channel routes arrive lazily BEHIND it. Reporting `{}`
    // would make the startup line claim nothing is served.
    routes: adapterRoutes,
    agentDir,
    workspace,
    // Unknown at boot by design — a channel list here would be the pre-restore emptiness.
    channels: { routes: [], longConnections: [], builtinInvoke: false },
    schedules: scheduled.schedules,
    ready: Promise.resolve(), // nothing to open: no port of our own, no resident connections
    ...(withControl.control ? { control: withControl.control } : {}),
    announce(boundPort) {
      unannounce = withControl.announce(boundPort);
    },
    async close() {
      // UNTESTED, deliberately noted: no test observes these timers being cleared. Installing fake
      // timers early enough to count them deadlocks the assembly's own IO. What IS tested is that
      // close() runs and is idempotent; the stop itself rides on scheduler.stop()'s own tests.
      scheduled.stop();
      closed.abort();
      unannounce?.(); // a stale discovery file would point `attach` at a stopped service
    },
  };
}

/**
 * Mount the AgentCore Runtime adapter (`POST /invocations` + `GET /ping`) over the serving routes —
 * the deployed container's ONLY reachable surface (channels/agentcore.ts). Wired by `start` when
 * `FASTAGENT_AGENTCORE=1` (set by the generated deploy artifacts, never by hand). A channel colliding
 * on either path fails startup, same disposition as the control-plane mount: the adapter's paths are
 * the platform's contract, so a channel shadowing them would silently unserve the whole deployment.
 */
export function mountAgentcore(
  routes: Routes,
  options: {
    agent: Agent;
    stateRoot: string;
    schedules: readonly LoadedSchedule[];
    onStateReady?: () => void;
    /** Cancels the adapter's process-global registrations on close. */
    signal?: AbortSignal;
    /** The serving path's LAZY channel surface: constructed by the adapter on the first envelope
     *  AFTER the state-snapshot restore, never at boot (channels/agentcore.ts). When absent,
     *  `routes` is the dispatch target — for wirings whose state root is already authoritative. */
    lazyChannels?: () => Promise<RouteSurface>;
  },
): Routes {
  const { agent, stateRoot, schedules, onStateReady, lazyChannels, signal } = options;
  const mounted = agentcoreRoutes({
    routes: lazyChannels ?? { routes },
    agent,
    stateRoot,
    isBusy: () => activeWork() > 0,
    // Cross-deploy durability: AgentCore wipes the state mount on every runtime version update, so
    // the state root is restored from (and pushed to) an S3 snapshot through presigned URLs the
    // forwarder mints per envelope. Always wired on this path — the platform gives no other way to
    // keep an agent's memory across a deploy.
    stateSync: createStateSync({ stateRoot }),
    // What separates a forwarder envelope from any IAM principal's InvokeAgentRuntime call. Absent =
    // no forwarder in this topology, so only the public `invoke` kind is servable.
    ingressSecret: process.env.FASTAGENT_INGRESS_SECRET,
    onStateReady,
    ...(signal ? { signal } : {}),
    fire:
      schedules.length === 0
        ? undefined
        : (name, slot) => {
            const schedule = schedules.find((s) => s.name === name);
            if (!schedule) throw new UnknownScheduleError(name);
            return fireScheduleOnce({ agent, stateRoot, schedule, slot });
          },
  });
  const collisions = Object.keys(routes).filter((key) =>
    Object.keys(mounted).some((adapterKey) => routeKeysConflict(key, adapterKey)),
  );
  if (collisions.length > 0) {
    throw new Error(
      `channel route(s) ${collisions.map((key) => `"${key}"`).join(", ")} collide with the AgentCore adapter ` +
        `(/invocations, /ping) — rename the channel route`,
    );
  }
  return { ...routes, ...mounted };
}
