/** The AgentCore serving assembly — the same product as `serveAgent`, built differently because the host is. */
import type { Agent } from "../agent-api.ts";
import { fromForwarder } from "./agentcore-protocol.ts";
import { log } from "../log.ts";
import type { Routes } from "../channel.ts";
import type { Schedule } from "../schedule/schedule.ts";
import {
  type ServableAgent,
  type ServedAgent,
  type Service,
  routesFor,
  serviceOver,
  startSchedules,
} from "../service.ts";
import { type AgentcoreAdapterOptions, type RouteSurface, agentcoreRoutes, agentcorePing } from "./agentcore.ts";
import * as Effect from "effect/Effect";
import { fireScheduleOnce } from "../schedule/scheduler.ts";
import { nextRun } from "../schedule/cron.ts";
import { createWakeAlarmSink } from "../schedule/wake-alarm.ts";
import { setWakeupsSink } from "../schedule/wakeups.ts";
import { text } from "./respond.ts";
import { activeWork, beginWork } from "./busy.ts";
import type { ChannelHandler } from "../channel.ts";
import { router } from "./router.ts";
import { readBodyCapped } from "./body.ts";
import { MAX_ENVELOPE_BYTES } from "./agentcore-limits.ts";

/**
 * Runtime filesystems appear on invocation, so even opening the definition must be deferred — in the TWO stages that
 * differ in what a retry would cost.
 */
export function deferAgentcoreService<T>(stages: {
  prepare: () => Promise<T>;
  assemble: (prepared: T) => Promise<ServedAgent>;
}): Service {
  let service: ServedAgent | undefined;
  let prepared: Promise<T> | undefined;
  let assembling: Promise<ServedAgent> | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  const ping = agentcorePing(() => activeWork() > 0);
  const initialize = async (): Promise<ServedAgent> => {
    const done = beginWork();
    try {
      prepared ??= stages.prepare().catch((error: unknown) => {
        prepared = undefined; // nothing was taken, so the next envelope may ask again
        throw error;
      });
      const taken = await prepared;
      // Shutdown may have arrived while the storage was being taken.
      if (closed) throw new Error("service closed during initialization");
      assembling ??= stages.assemble(taken);
      service = await assembling;
      return service;
    } finally {
      done();
    }
  };
  const handler: ChannelHandler = async (request) => {
    if (closed) return new Response("service closed\n", { status: 503 });
    if (service) return service.fetch(request);
    const path = new URL(request.url).pathname;
    if (path === "/ping" && request.method === "GET") return ping(request);
    if (path !== "/invocations" || request.method !== "POST") return new Response("not found\n", { status: 404 });
    let ready: ServedAgent;
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
        if (envelope?.kind === "probe" && fromForwarder(envelope, process.env.FASTAGENT_INGRESS_SECRET)) {
          return Response.json({ ok: false, error: message });
        }
      }
      return new Response(`${message}\n`, { status: 503 });
    }
    if (closed) return new Response("service closed\n", { status: 503 });
    return ready.fetch(request);
  };
  // Nothing to wait for before the first envelope: the definition opens on it.
  return serviceOver(handler, Promise.resolve(), () => {
    closed = true;
    closing ??= (async () => {
      // A failed assembly already reached its caller.
      await (await assembling?.catch(() => undefined))?.close();
    })();
    return closing;
  });
}

export async function mountAgentcoreService(opened: ServableAgent): Promise<ServedAgent> {
  const { agent, agentDir, stateRoot, schedules } = opened;

  // The only public way in is the forwarder's Function URL, which relays an arbitrary `rawPath` verbatim as a webhook
  // envelope and attaches the ingress secret ITSELF (deploy/agentcore/forwarder.js), so every anonymous caller arrives
  // as trusted ingress. A channel route survives that because it checks its platform's signature.
  //
  // Started here, not deferred to an envelope. No resident timers: each instant arrives as its own fire from the
  // recurring schedule the container sets (`armAlarms`), ONE path per instant, so the reply to that delivery says
  // whether it ran. The clock still pumps wake-ups; a redelivered fire claims its slot once.
  const mirror = armAlarms(stateRoot, () => schedules);
  const scheduled = startSchedules(agent, stateRoot, schedules, { localClock: false });

  const lazyChannels = async (): Promise<RouteSurface> => {
    const lazy = routesFor(agent, stateRoot, opened.channels);
    if (lazy.longConnections.length > 0) {
      throw new Error(
        `long-connection channel(s) ${lazy.longConnections.map((c) => c.name).join(", ")} cannot serve on ` +
          `AgentCore (scale-to-zero severs resident connections) — use the channel's webhook form`,
      );
    }
    return { routes: lazy.routes };
  };

  const adapterRoutes = mountAgentcore({
    agent,
    stateRoot,
    schedules: () => schedules,
    ...(mirror ? { onStateReady: mirror } : {}),
    channels: lazyChannels,
  });
  const handler = router(adapterRoutes);
  log.info(`[fastagent] agentcore: serving POST /invocations + GET /ping (FASTAGENT_AGENTCORE=1)`);

  return {
    // Nothing to open: no port of its own, no resident connections.
    ...serviceOver(handler, Promise.resolve(), async () => scheduled.stop()),
    // The adapter IS the surface here; the channel routes arrive lazily BEHIND it.
    routes: adapterRoutes,
    agentDir,
    // Channels remain lazy until the adapter receives trusted ingress.
    channels: { routes: [], longConnections: [] },
    schedules,
    // Reached only through /invocations here (SPEC.md §9.5).
    api: false,
  };
}

/**
 * Mount the AgentCore Runtime adapter (`POST /invocations` + `GET /ping`) — the deployed container's ONLY reachable
 * surface (channels/agentcore.ts).
 */
export function mountAgentcore(options: {
  agent: Agent;
  stateRoot: string;
  schedules: () => readonly Schedule[];
  onStateReady?: () => void;
  /** The channel surface, initialized once by the adapter on trusted ingress. */
  channels: AgentcoreAdapterOptions["channels"];
}): Routes {
  const { agent, stateRoot, schedules, onStateReady, channels } = options;
  // OCCURRENCE SEMANTICS, because this host's clock is ours: the container set the recurring schedule that names this
  // instant and the forwarder relays it behind the ingress secret, so a claim means something (dedup across
  // EventBridge's redeliveries, a fire history, the overlap policy).
  const fireSchedule = async (name: string, occurrence: Date): Promise<Response> => {
    const schedule = schedules().find((s) => s.name === name);
    // EventBridge can fire what a release has not reached yet (a mirror still in flight, or one that failed): a fire
    // for a schedule since removed, or for an instant its cron no longer has, is answered as skipped, not run — and not
    // as an error the forwarder would make EventBridge retry.
    const skip = (why: string) => {
      log.info(`[schedule] ${name}: alarm for ${occurrence.toISOString()} skipped — ${why}`);
      return Response.json({ slot: occurrence.toISOString(), fired: false, skippedReason: why, ms: 0 });
    };
    if (!schedule) return skip("no such schedule any more");
    if (nextRun(schedule.cron, schedule.tz, new Date(occurrence.getTime() - 1))?.getTime() !== occurrence.getTime()) {
      return skip(`not an instant of its cron "${schedule.cron}" any more`);
    }
    const outcome = await Effect.runPromise(
      fireScheduleOnce({ agent, stateRoot, schedule, slot: occurrence }).pipe(Effect.mapError((e) => e.cause)),
    ).catch((cause: unknown) => {
      // `fireScheduleOnce`'s only failure is a claim-state fault, which happens BEFORE any claim exists — the
      // occurrence is unburned, so the forwarder's throw makes EventBridge retry it, which is the right answer.
      log.error(`[schedule] firing "${name}" for ${occurrence.toISOString()} failed: ${String(cause)}`);
      return undefined;
    });
    if (outcome === undefined) {
      return text(`schedule "${name}": claim state unavailable, nothing was claimed — retry\n`, 500);
    }
    return Response.json({ slot: occurrence.toISOString(), ...outcome });
  };
  return agentcoreRoutes({
    channels,
    stateRoot,
    isBusy: () => activeWork() > 0,
    // What separates a forwarder envelope from any IAM principal's InvokeAgentRuntime call.
    ingressSecret: process.env.FASTAGENT_INGRESS_SECRET,
    onStateReady,
    fireSchedule,
  });
}

/**
 * The alarm mirror: each schedule as a recurring EventBridge schedule and each pending wake-up as a one-shot one, set
 * by the forwarder (schedule/wake-alarm.ts), so a container AgentCore reclaimed is woken for them. Installed BEFORE the
 * clock starts: the first wake poll may advance a recurring entry, and that save must already re-arm its alarm.
 * Without the wake secret there is no way to set one, which is said.
 */
function armAlarms(stateRoot: string, schedules: () => readonly Schedule[]): (() => void) | undefined {
  const secret = process.env.FASTAGENT_WAKE_SECRET;
  if (!secret) {
    log.warn("[fastagent] FASTAGENT_WAKE_SECRET is missing; wake-ups and schedules cannot wake a reclaimed container");
    return undefined;
  }
  const sink = Effect.runSync(createWakeAlarmSink({ secret, schedules }));
  setWakeupsSink(sink);
  return () => sink(stateRoot);
}
