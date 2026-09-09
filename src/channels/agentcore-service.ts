/** The AgentCore serving assembly — the same product as `mountAgentService`, built differently because the host is. */
import * as Effect from "effect/Effect";
import type { Agent } from "../agent.ts";
import { log } from "../log.ts";
import type { Routes } from "../channel.ts";
import type { LoadedSchedule } from "../schedule/schedule.ts";
import { fireScheduleOnce } from "../schedule/scheduler.ts";
import {
  type AgentService,
  type MountableAgent,
  assertNoControlPlaneCollision,
  mountSessionControl,
  routesFor,
  startSchedules,
} from "../service.ts";
import {
  type AgentcoreAdapterOptions,
  type RouteSurface,
  UnknownScheduleError,
  agentcoreRoutes,
  agentcorePing,
} from "./agentcore.ts";
import { activeWork, beginWork } from "./busy.ts";
import type { ChannelHandler } from "../channel.ts";
import { router } from "./serve.ts";
import { readBodyCapped } from "./body.ts";
import { MAX_ENVELOPE_BYTES } from "./agentcore-limits.ts";
import { secretEquals } from "./secret.ts";

/**
 * Runtime filesystems appear on invocation, so even opening the definition must be deferred — in the TWO stages that
 * differ in what a retry would cost.
 */
export function deferAgentcoreService<T>(stages: {
  prepare: () => Promise<T>;
  assemble: (prepared: T) => Promise<AgentService>;
}): {
  handler: ChannelHandler;
  close: () => Promise<void>;
} {
  let service: AgentService | undefined;
  let prepared: Promise<T> | undefined;
  let assembling: Promise<AgentService> | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  const ping = agentcorePing(() => activeWork() > 0);
  const initialize = async (): Promise<AgentService> => {
    const done = beginWork();
    try {
      prepared ??= stages.prepare().catch((error: unknown) => {
        prepared = undefined; // nothing was taken, so the next envelope may ask again
        throw error;
      });
      const taken = await prepared;
      // Shutdown may have arrived while the workspace was being taken.
      if (closed) throw new Error("service closed during initialization");
      assembling ??= stages.assemble(taken);
      service = await assembling;
      return service;
    } finally {
      done();
    }
  };
  return {
    handler: async (request) => {
      if (closed) return new Response("service closed\n", { status: 503 });
      if (service) return service.handler(request);
      const path = new URL(request.url).pathname;
      if (path === "/ping" && request.method === "GET") return ping(request);
      if (path !== "/invocations" || request.method !== "POST") return new Response("not found\n", { status: 404 });
      let ready: AgentService;
      // Only the INITIALIZATION is caught here.
      try {
        ready = await initialize();
      } catch (error) {
        const message = `initialization failed: ${String(error)}`;
        log.error(`[agentcore] ${message}`);
        const body = await readBodyCapped(request, MAX_ENVELOPE_BYTES);
        if (!("tooLarge" in body)) {
          let envelope: { kind?: unknown; auth?: unknown } | undefined;
          try {
            envelope = JSON.parse(body.text);
          } catch {
            // Invalid envelopes retain the initialization error.
          }
          if (envelope?.kind === "probe" && secretEquals(envelope.auth, process.env.FASTAGENT_INGRESS_SECRET)) {
            return Response.json({ ok: false, error: message });
          }
        }
        return new Response(`${message}\n`, { status: 503 });
      }
      if (closed) return new Response("service closed\n", { status: 503 });
      return ready.handler(request);
    },
    close() {
      closed = true;
      closing ??= (async () => {
        // A failed assembly already reached its caller.
        await (await assembling?.catch(() => undefined))?.close();
      })();
      return closing;
    },
  };
}

export interface MountAgentcoreServiceOptions {
  /** Wrap the opened agent before anything binds to it (the CLI's turn trace). */
  wrapAgent?: (agent: Agent) => Agent;
  /** The process entry owns the global wake-alarm sink; activation reconciles it once. */
  onStateReady?: () => void;
}

export async function mountAgentcoreService(
  opened: MountableAgent,
  options: MountAgentcoreServiceOptions = {},
): Promise<AgentService> {
  const { agentDir, workspace, stateRoot, sessionControl } = opened;
  const agent = options.wrapAgent?.(opened.agent) ?? opened.agent;

  // The control plane mounts over an EMPTY route surface: the lazy channels join it later, and the collision rule
  // runs again then (below) against what they actually brought.
  const withControl = mountSessionControl({}, sessionControl, { agent });

  // Started here, not deferred to an envelope.
  const scheduled = await startSchedules(agentDir, agent, stateRoot, opened.selfSchedule, {
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
    // The SAME rule mountSessionControl applies, through the same function: its check ran against an empty base at
    // boot, so it has to run again once the channels are real.
    for (const plane of withControl.mounts) assertNoControlPlaneCollision(lazy.routes, plane);
    return { routes: lazy.routes, mounts: withControl.mounts };
  };

  const adapterRoutes = mountAgentcore({
    agent,
    stateRoot,
    schedules: scheduled.schedules,
    onStateReady: options.onStateReady,
    channels: lazyChannels,
  });
  const handler = router(adapterRoutes, withControl.mounts);
  log.info(`[fastagent] agentcore: serving POST /invocations + GET /ping (FASTAGENT_AGENTCORE=1)`);

  return {
    handler,
    agent,
    // The adapter IS the surface here; the channel routes arrive lazily BEHIND it.
    routes: adapterRoutes,
    agentDir,
    workspace,
    // Channels remain lazy until the adapter receives trusted ingress.
    channels: { routes: [], longConnections: [], builtinInvoke: false },
    schedules: scheduled.schedules,
    ready: Promise.resolve(), // nothing to open: no port of our own, no resident connections
    ...(withControl.control ? { control: withControl.control } : {}),
    async close() {
      scheduled.stop();
    },
  };
}

/**
 * Mount the AgentCore Runtime adapter (`POST /invocations` + `GET /ping`) — the deployed container's ONLY reachable
 * surface (channels/agentcore.ts).
 */
export function mountAgentcore(options: {
  agent: Agent;
  stateRoot: string;
  schedules: readonly LoadedSchedule[];
  onStateReady?: () => void;
  /** The channel surface, initialized once by the adapter on trusted ingress. */
  channels: AgentcoreAdapterOptions["channels"];
}): Routes {
  const { agent, stateRoot, schedules, onStateReady, channels } = options;
  return agentcoreRoutes({
    channels,
    agent,
    stateRoot,
    isBusy: () => activeWork() > 0,
    // What separates a forwarder envelope from any IAM principal's InvokeAgentRuntime call.
    ingressSecret: process.env.FASTAGENT_INGRESS_SECRET,
    onStateReady,
    fire:
      schedules.length === 0
        ? undefined
        : (name, slot) => {
            const schedule = schedules.find((s) => s.name === name);
            if (!schedule) throw new UnknownScheduleError(name);
            return Effect.runPromise(
              fireScheduleOnce({ agent, stateRoot, schedule, slot }).pipe(Effect.mapError((error) => error.cause)),
            );
          },
  });
}
