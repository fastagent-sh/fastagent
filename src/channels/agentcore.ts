/** AWS AgentCore Runtime adapter: serve fastagent's whole HTTP surface through the Runtime's service contract. */
import { Buffer } from "node:buffer";
import * as Effect from "effect/Effect";
import { PortFailure, portJoin } from "../effect-port.ts";
import type { Agent } from "../protocol.ts";
import {
  type AgentcoreEnvelope,
  type CarriedRequest,
  ENVELOPE_KINDS,
  fromForwarder,
  type WebhookReply,
} from "./agentcore-protocol.ts";
import { beginWork } from "./busy.ts";
import type { ChannelHandler, Routes } from "../channel.ts";
import { router } from "../channels/router.ts";
import { log } from "../log.ts";
import { once } from "../once.ts";
import { rememberWakeAlarmUrl } from "../schedule/wake-alarm.ts";
import { readBodyCapped } from "./body.ts";
import { protocolHttp } from "./protocol-http.ts";
import { text } from "./respond.ts";
import { MAX_ENVELOPE_BYTES, MAX_WEBHOOK_BODY_BYTES } from "./agentcore-limits.ts";

/**
 * What the lazy factory hands back: the CHANNELS' routes, and nothing else.
 *
 * Deliberately not "the whole inner surface". Every request that reaches this dispatcher arrived through the
 * forwarder's public Function URL, which relays an arbitrary path verbatim and supplies the ingress secret itself —
 * so behind THIS door an anonymous caller and an IAM one are the same thing. A channel route survives that because
 * it verifies the platform's signature inside itself; nothing fastagent serves does.
 *
 * The other door is the Runtime's own, IAM-gated: the forwarder emits only `webhook`, `schedule-fire`, `wake-poke`
 * and `probe`, so any other KIND can only come from a direct `InvokeAgentRuntime` call. That is what lets
 * `kind: "api"` reach the agent's API here with no ingress secret: IAM is this host's gateway.
 */
export interface RouteSurface {
  routes: Routes;
}

export interface AgentcoreAdapterOptions {
  /** The channel surface. */
  channels: () => Promise<RouteSurface> | RouteSurface;
  agent: Agent;
  /** Where the forwarder URL from envelopes is persisted for the wake-alarm sink (the state root). */
  stateRoot: string;
  /** Process-wide background-work signal (busy.ts `activeWork() > 0`) — injected for tests. */
  isBusy: () => boolean;
  /**
   * Fire ONE declared schedule for the occurrence EventBridge named — the claim/run/settle the resident clock uses.
   *
   * The container set the recurring schedule that names this instant and the forwarder relays it behind the ingress
   * secret, so this caller is one we produced and authenticated, which is what makes a claim (and therefore dedup
   * across EventBridge's redeliveries, a fire history and the overlap policy) mean anything. Always present: a
   * schedule can be added while the container runs, and a fire for one since removed is answered by it, as skipped.
   */
  fireSchedule: (name: string, occurrence: Date) => Promise<Response>;
  /** FASTAGENT_INGRESS_SECRET: what makes an envelope the FORWARDER's rather than any IAM principal's. */
  ingressSecret?: string;
  /** Runs once on activation, after accepting the current forwarder callback URL. */
  onStateReady?: () => void;
}

const jsonHeaders = { "content-type": "application/json" } as const;
const json = (body: unknown, status: number): Response =>
  new Response(`${JSON.stringify(body)}\n`, { status, headers: jsonHeaders });

/**
 * Channel construction may already have replayed work before failing; cache either outcome to avoid replaying twice.
 */
function createActivation(deps: {
  stateRoot: string;
  onStateReady: (() => void) | undefined;
  channels: AgentcoreAdapterOptions["channels"];
}): {
  prepare(envelope: AgentcoreEnvelope): Effect.Effect<void, PortFailure>;
  /** The channel surface; the construction outcome is cached either way. */
  channels: Effect.Effect<ChannelHandler, PortFailure>;
} {
  const { stateRoot, onStateReady } = deps;
  const stateReady = once(
    portJoin(async () => {
      onStateReady?.();
    }),
  );
  const channels = once(
    portJoin(async () => {
      const surface = await deps.channels();
      return router({ selfVerifying: surface.routes });
    }),
  );
  return {
    prepare: (envelope) =>
      Effect.gen(function* () {
        // Use the current callback URL rather than the one persisted by an earlier deployment.
        if (typeof envelope.wake?.url === "string") {
          const url = envelope.wake.url;
          yield* Effect.try({
            try: () => rememberWakeAlarmUrl(stateRoot, url),
            catch: (cause) => new PortFailure(cause),
          });
        }
        yield* stateReady;
      }),
    channels,
  };
}

export function agentcoreRoutes(options: AgentcoreAdapterOptions): Routes {
  const { channels, agent, stateRoot, isBusy, fireSchedule, ingressSecret, onStateReady } = options;
  const activation = createActivation({ stateRoot, onStateReady, channels });
  // Both planes: IAM, which decided this caller may invoke the runtime at all, is the gateway (agent-service.md §7.7).
  const planes = protocolHttp(agent);
  const api = router({ unverified: planes.user.routes, mounts: [...planes.user.mounts, planes.control] });
  const carried = (request: CarriedRequest): Request => {
    const { method, path, query, headers, bodyB64 } = request;
    return new Request(`http://agentcore.local${path}${typeof query === "string" && query !== "" ? `?${query}` : ""}`, {
      method,
      headers: headers ?? {},
      body:
        typeof bodyB64 === "string" && method !== "GET" && method !== "HEAD"
          ? Buffer.from(bodyB64, "base64")
          : undefined,
    });
  };
  const malformed = (request: Partial<CarriedRequest>): boolean =>
    typeof request.method !== "string" || typeof request.path !== "string" || !request.path.startsWith("/");

  const handleInvocation = async (req: Request): Promise<Response> => {
    const body = await readBodyCapped(req, MAX_ENVELOPE_BYTES);
    if ("tooLarge" in body) return text("envelope too large\n", 413);
    let envelope: AgentcoreEnvelope;
    try {
      envelope = JSON.parse(body.text) as AgentcoreEnvelope;
    } catch {
      return text("invalid json\n", 400);
    }
    if (envelope === null || typeof envelope !== "object" || typeof envelope.kind !== "string") {
      return text(`need { "kind": ${ENVELOPE_KINDS.map((k) => `"${k}"`).join(" | ")}, ... }\n`, 400);
    }
    // The forwarder, or another IAM principal? See `fromForwarder` for what that actually decides.
    const trusted = fromForwarder(envelope, ingressSecret);
    if (!trusted) {
      // The IAM door's kinds: AWS authenticated this caller, so no ingress secret is expected or wanted. A `probe`
      // here only opens the deployed definition (the deferred wrapper did that before this line) and says so: it is
      // how `login --deployment` gets a definition to log in, after a reset, on a runtime nothing has invoked yet.
      if (envelope.kind !== "api" && envelope.kind !== "probe") {
        log.warn(`[agentcore] rejected an unauthenticated "${envelope.kind}" envelope`);
        return text("forbidden\n", 403);
      }
      envelope.wake = undefined;
    }
    try {
      if (trusted) await Effect.runPromise(activation.prepare(envelope).pipe(Effect.mapError((e) => e.cause)));
    } catch (e) {
      log.error(`[agentcore] activation failed: ${String(e)}`);
      // The probe is the deploy driver's verification channel: its diagnostics must survive the forwarder, which
      // folds a non-200 transport into an opaque 502.
      if (envelope.kind === "probe") return json({ ok: false, error: `activation failed: ${String(e)}` }, 200);
      return text(`activation failed: ${String(e)}\n`, 503);
    }
    // A call to the agent's API does not activate channels.
    let constructionError: string | undefined;
    let dispatch: ChannelHandler | undefined;
    if (trusted && envelope.kind !== "api") {
      try {
        dispatch = await Effect.runPromise(activation.channels.pipe(Effect.mapError((error) => error.cause)));
      } catch (e) {
        constructionError = String(e);
        log.error(`[agentcore] channel construction failed: ${constructionError}`);
      }
    }

    switch (envelope.kind) {
      case "webhook": {
        const { bodyB64 } = envelope;
        if (malformed(envelope)) return text('webhook envelope needs { "method": string, "path": "/..." }\n', 400);
        if (typeof bodyB64 === "string" && Buffer.byteLength(bodyB64, "base64") > MAX_WEBHOOK_BODY_BYTES) {
          return json(
            {
              status: 413,
              headers: { "content-type": "text/plain" },
              bodyB64: Buffer.from("payload too large\n").toString("base64"),
            },
            200,
          );
        }
        const inner = carried(envelope);
        // A construction failure is the request's failure (503 through the forwarder, so the platform retries and the
        // operator sees the message), never a silently-empty channel.
        if (!dispatch) return text(`channel construction failed: ${constructionError ?? "unavailable"}\n`, 503);
        const response = await dispatch(inner);
        // Buffer the channel's ACK (webhook ACKs are small by design — the turn itself runs fire-and-forget) and ride
        // it inside the transport reply, byte-exact.
        const replyBody = Buffer.from(await response.arrayBuffer());
        const replyHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          replyHeaders[key] = value;
        });
        const reply: WebhookReply = {
          status: response.status,
          headers: replyHeaders,
          bodyB64: replyBody.toString("base64"),
        };
        return json(reply, 200);
      }
      case "schedule-fire": {
        const { name, occurrence } = envelope;
        if (typeof name !== "string" || typeof occurrence !== "string" || Number.isNaN(Date.parse(occurrence))) {
          return text('schedule-fire envelope needs { "name": string, "occurrence": ISO-date }\n', 400);
        }
        // The whole agent turn runs inside this request — but the CALLER (the forwarder Lambda) may time out and drop
        // the connection while the turn keeps running server-side.
        const workDone = beginWork();
        try {
          return await fireSchedule(name, new Date(occurrence));
        } finally {
          workDone();
        }
      }
      case "wake-poke": {
        // The poke's job is DONE by arriving: the invocation woke (or kept awake) the container, and the wake pump
        // (boot drain + 30s poll) fires whatever is due.
        if (constructionError !== undefined) return text(`channel construction failed: ${constructionError}\n`, 503);
        return json({ ok: true }, 200);
      }
      case "probe": {
        // The structured verdict (transport-200 — see the envelope doc). From the IAM door (untrusted) nothing was
        // activated, so `ok` says only that the definition opened; channel construction is the forwarder probe's.
        return json(
          constructionError === undefined
            ? { ok: true }
            : { ok: false, error: `channel construction failed: ${constructionError}` },
          200,
        );
      }
      case "api": {
        // The agent's API answers as itself, its event streams included: one binding, carried two ways.
        if (malformed(envelope)) return text('api envelope needs { "method": string, "path": "/..." }\n', 400);
        return api(carried(envelope));
      }
      default:
        return text(`unknown envelope kind "${(envelope as { kind: string }).kind}"\n`, 400);
    }
  };

  return { "POST /invocations": handleInvocation, "GET /ping": agentcorePing(isBusy) };
}

export function agentcorePing(isBusy: () => boolean): ChannelHandler {
  // The Runtime ping contract: Healthy = reclaimable, HealthyBusy = keep the session alive (background turns in
  // flight).
  let lastStatus = "Healthy";
  let lastTransition = Math.floor(Date.now() / 1000);
  return () => {
    const status = isBusy() ? "HealthyBusy" : "Healthy";
    if (status !== lastStatus) {
      lastTransition = Math.floor(Date.now() / 1000);
      log.debug(`[agentcore] ping status: ${lastStatus} → ${status}`);
      lastStatus = status;
    }
    return json({ status, time_of_last_update: lastTransition }, 200);
  };
}
