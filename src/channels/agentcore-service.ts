/** The AgentCore serving assembly — the same product as `mountAgentService`, built differently because the host is. */
import type { Agent } from "../agent.ts";
import { fromForwarder } from "./agentcore-protocol.ts";
import { log } from "../log.ts";
import type { Routes } from "../channel.ts";
import type { LoadedRoutine } from "../schedule/routine.ts";
import { type AgentService, loadServingRoutines, type MountableAgent, routesFor, startSchedules } from "../service.ts";
import { type AgentcoreAdapterOptions, type RouteSurface, agentcoreRoutes, agentcorePing } from "./agentcore.ts";
import * as Effect from "effect/Effect";
import { runRoutineByName, unknownRoutine } from "../schedule/run.ts";
import { fireRoutineOnce } from "../schedule/scheduler.ts";
import { text } from "./respond.ts";
import { activeWork, beginWork } from "./busy.ts";
import type { ChannelHandler } from "../channel.ts";
import { router } from "./serve.ts";
import { readBodyCapped } from "./body.ts";
import { MAX_ENVELOPE_BYTES } from "./agentcore-limits.ts";

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
          if (envelope?.kind === "probe" && fromForwarder(envelope, process.env.FASTAGENT_INGRESS_SECRET)) {
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

  // NO control plane on this host, and `sessionControl: true` cannot change that. The only public way in is the
  // forwarder's Function URL, which relays an arbitrary `rawPath` verbatim as a webhook envelope and attaches the
  // ingress secret ITSELF (deploy/agentcore/forwarder.js), so every anonymous caller arrives as trusted ingress. A
  // channel route survives that because it checks its platform's signature; `/control/*` has no such check.
  //
  // The recipe if it is ever wanted: a `kind: "control"` envelope on the IAM-gated `InvokeAgentRuntime`, which the
  // forwarder never emits (the way `kind: "invoke"` runs a turn without the ingress secret). The envelope is
  // request/response with a buffered body, so the long-lived `GET /control/sessions/{id}/events` stream a client
  // renders from could not ride it.
  //
  // Every config key that cannot mean anything on this host says so: silence is how an operator concludes a setting
  // took effect.
  if (opened.http?.cors) {
    log.warn(
      "[fastagent] agentcore: http.cors has no effect here — no browser reaches this container. Its ingress is the " +
        "forwarder's Function URL (webhooks) and the Runtime's IAM-gated API, neither of which is a page.",
    );
  }
  if (opened.http?.invoke !== undefined) {
    log.warn(
      "[fastagent] agentcore: http.invoke has no effect here — this host serves the Runtime's POST /invocations " +
        "contract instead of our own /invoke, and reaching it already requires bedrock-agentcore:InvokeAgentRuntime.",
    );
  }
  if (opened.http?.run !== undefined) {
    log.warn(
      "[fastagent] agentcore: http.run has no effect here — routines fire through the forwarder's " +
        "routine-fire envelope, which is gated by the ingress secret rather than served as an anonymous route.",
    );
  }
  if (opened.publishControl) {
    log.warn(
      "[fastagent] agentcore: sessionControl is ON but /control/* is NOT served here — this host's only public " +
        "ingress relays anonymous traffic as trusted, so the plane is not assembled behind it " +
        "(docs/design/session-control.md §14)",
    );
  }

  // Started here, not deferred to an envelope.
  const routines = await loadServingRoutines(agentDir);
  const scheduled = startSchedules(agent, stateRoot, routines, { externalClock: true });

  const lazyChannels = async (): Promise<RouteSurface> => {
    const lazy = await routesFor(agentDir, agent, stateRoot, sessionControl, { http: { invoke: false } });
    if (lazy.longConnections.length > 0) {
      throw new Error(
        `long-connection channel(s) ${lazy.longConnections.map((c) => c.name).join(", ")} cannot serve on ` +
          `AgentCore (scale-to-zero severs resident connections) — use the channel's webhook form`,
      );
    }
    // CHANNELS ONLY — nothing unverified rides the public relay. `lazy.unverified` (here just `GET /health`) is dropped
    // with the control plane, for the same reason: what arrives through that URL is anonymous.
    return { routes: lazy.selfVerifying };
  };

  const adapterRoutes = mountAgentcore({
    agent,
    stateRoot,
    routines: scheduled.routines,
    onStateReady: options.onStateReady,
    channels: lazyChannels,
  });
  // SELF-VERIFYING, not unverified: both paths are reached only through `InvokeAgentRuntime`, which AWS gates with
  // IAM. Putting them in the other table applied our JSON body gate to `POST /invocations` (whose content type is
  // AWS's to set) and reported two IAM-protected paths as authenticating nobody.
  const handler = router({ selfVerifying: adapterRoutes });
  log.info(`[fastagent] agentcore: serving POST /invocations + GET /ping (FASTAGENT_AGENTCORE=1)`);

  return {
    handler,
    agent,
    // The adapter IS the surface here; the channel routes arrive lazily BEHIND it.
    routes: adapterRoutes,
    agentDir,
    workspace,
    // Channels remain lazy until the adapter receives trusted ingress.
    channels: { routes: [], longConnections: [] },
    // NONE: the adapter's two paths are IAM-gated and the channels behind them verify their own platform.
    unverifiedRoutes: [],
    // No `controlPrefix`: it is not served here, so nothing may report a prefix a caller could dial.
    routines: scheduled.routines,
    ready: Promise.resolve(), // nothing to open: no port of our own, no resident connections
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
  routines: readonly LoadedRoutine[];
  onStateReady?: () => void;
  /** The channel surface, initialized once by the adapter on trusted ingress. */
  channels: AgentcoreAdapterOptions["channels"];
}): Routes {
  const { agent, stateRoot, routines, onStateReady, channels } = options;
  // OCCURRENCE SEMANTICS, because this host's clock is ours: `deploy` wrote the EventBridge rule and the forwarder
  // relays its instant behind the ingress secret, so the slot is a real grid point of that schedule and a claim
  // means something (dedup across redeliveries, a fire history, the overlap policy). `POST /run` — the
  // unauthenticated API — is NOT this and is not served here at all.
  const fireRoutine = async (name: string, occurrence: Date): Promise<Response> => {
    const routine = routines.find((r) => r.name === name);
    if (!routine) return unknownRoutine(name, routines);
    const outcome = await Effect.runPromise(
      fireRoutineOnce({ agent, stateRoot, routine, slot: occurrence }).pipe(Effect.mapError((e) => e.cause)),
    ).catch((cause: unknown) => {
      // `fireRoutineOnce`'s only failure is a claim-state fault, which happens BEFORE any claim exists — the
      // occurrence is unburned, so the forwarder's throw makes EventBridge retry it, which is the right answer.
      log.error(`[schedule] firing "${name}" for ${occurrence.toISOString()} failed: ${String(cause)}`);
      return undefined;
    });
    if (outcome === undefined) {
      return text(`routine "${name}": claim state unavailable, nothing was claimed — retry\n`, 500);
    }
    return Response.json({ slot: occurrence.toISOString(), ...outcome });
  };
  // BY NAME, on the IAM door. `POST /run`'s contract, through the only ingress this host has for a caller AWS has
  // already identified — which makes it stricter here than the anonymous route other hosts publish. A routine
  // without a cron is reachable ONLY this way on this host, and that is the point: nothing is unreachable.
  const runRoutine = async (name: string): Promise<Response> => {
    const routine = routines.find((r) => r.name === name);
    if (!routine) return unknownRoutine(name, routines);
    return Response.json(await runRoutineByName(agent, routine));
  };
  return agentcoreRoutes({
    channels,
    agent,
    stateRoot,
    isBusy: () => activeWork() > 0,
    // What separates a forwarder envelope from any IAM principal's InvokeAgentRuntime call.
    ingressSecret: process.env.FASTAGENT_INGRESS_SECRET,
    onStateReady,
    ...(routines.length > 0 ? { fireRoutine, runRoutine } : {}),
  });
}
