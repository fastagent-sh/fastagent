/** AWS AgentCore Runtime adapter: serve fastagent's whole HTTP surface through the Runtime's service contract. */
import { Buffer } from "node:buffer";
import * as Effect from "effect/Effect";
import { PortFailure, portJoin } from "../effect-port.ts";
import type { Agent } from "../agent.ts";
import { type AgentcoreEnvelope, ENVELOPE_KINDS, type WebhookReply } from "./agentcore-protocol.ts";
import { beginWork } from "./busy.ts";
import type { ChannelHandler, Routes } from "../channel.ts";
import { type PrefixMount, router } from "../channels/serve.ts";
import { log } from "../log.ts";
import { rememberWakeAlarmUrl } from "../schedule/wake-alarm.ts";
import type { ScheduleFireOutcome } from "../schedule/scheduler.ts";
import { readBodyCapped } from "./body.ts";
import { createInvokeHandler } from "./http.ts";
import { text } from "./respond.ts";
import { secretEquals } from "./secret.ts";
import { MAX_ENVELOPE_BYTES, MAX_WEBHOOK_BODY_BYTES } from "./agentcore-limits.ts";

/**
 * What the lazy factory hands back: literal routes plus any prefix-owning mounts (the control plane), so the adapter's
 * INNER dispatch is assembled exactly like a direct host's.
 */
export interface RouteSurface {
  routes: Routes;
  mounts?: readonly PrefixMount[];
}

export interface AgentcoreAdapterOptions {
  /** The channel surface. */
  channels: () => Promise<RouteSurface> | RouteSurface;
  agent: Agent;
  /** Where the forwarder URL from envelopes is persisted for the wake-alarm sink (the state root). */
  stateRoot: string;
  /** Process-wide background-work signal (busy.ts `activeWork() > 0`) — injected for tests. */
  isBusy: () => boolean;
  /** Slot-idempotent schedule fire, bound to this workspace's schedules; undefined when the workspace has none. */
  fire?: (name: string, slot: Date) => Promise<ScheduleFireOutcome>;
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
  // UNINTERRUPTIBLE, because the outcome is CACHED: `Effect.cached` memoizes whatever exit it sees,
  // interruption included. A once-per-process activation that remembered "interrupted" would answer
  // every later envelope with an empty cause instead of the success or the diagnosable failure this
  // block promises. Both are already unreachable (no caller passes a signal), which is exactly why
  // the invariant has to be written down rather than relied on.
  const stateReady = Effect.runSync(
    Effect.cached(
      portJoin(async () => {
        onStateReady?.();
      }).pipe(Effect.uninterruptible),
    ),
  );
  const channels = Effect.runSync(
    Effect.cached(
      portJoin(async () => {
        const surface = await deps.channels();
        return router(surface.routes, surface.mounts);
      }).pipe(Effect.uninterruptible),
    ),
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
  const { channels, agent, stateRoot, isBusy, fire, ingressSecret, onStateReady } = options;
  const activation = createActivation({ stateRoot, onStateReady, channels });
  const invokeHandler = createInvokeHandler(agent);

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
    // AUTHENTICATION BOUNDARY.
    const trusted = secretEquals(envelope.auth, ingressSecret);
    if (!trusted) {
      if (envelope.kind !== "invoke") {
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
    // Public invokes do not activate channels.
    let constructionError: string | undefined;
    let dispatch: ChannelHandler | undefined;
    if (trusted && envelope.kind !== "invoke") {
      try {
        dispatch = await Effect.runPromise(activation.channels.pipe(Effect.mapError((error) => error.cause)));
      } catch (e) {
        constructionError = String(e);
        log.error(`[agentcore] channel construction failed: ${constructionError}`);
      }
    }

    switch (envelope.kind) {
      case "webhook": {
        const { method, path, query, headers, bodyB64 } = envelope;
        if (typeof method !== "string" || typeof path !== "string" || !path.startsWith("/")) {
          return text('webhook envelope needs { "method": string, "path": "/..." }\n', 400);
        }
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
        const inner = new Request(
          `http://agentcore.local${path}${typeof query === "string" && query !== "" ? `?${query}` : ""}`,
          {
            method,
            headers: headers ?? {},
            body:
              typeof bodyB64 === "string" && method !== "GET" && method !== "HEAD"
                ? Buffer.from(bodyB64, "base64")
                : undefined,
          },
        );
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
        const { name, slot } = envelope;
        if (typeof name !== "string" || typeof slot !== "string" || Number.isNaN(Date.parse(slot))) {
          return text('schedule-fire envelope needs { "name": string, "slot": ISO-date }\n', 400);
        }
        // No fire capability (no schedules in this definition) or an unknown name is deploy drift — an external clock
        // rule outliving the schedule it fired for.
        if (!fire) return text(`no schedules in this deployment (schedule-fire "${name}")\n`, 404);
        // The whole agent turn runs inside this request — but the CALLER (the forwarder Lambda) may time out and drop
        // the connection while the turn keeps running server-side.
        const workDone = beginWork();
        try {
          const outcome = await fire(name, new Date(slot));
          return json(outcome, 200);
        } catch (e) {
          if (e instanceof UnknownScheduleError) return text(`${e.message}\n`, 404);
          // A claim-state fault (unreadable/unwritable fires.json) — surface it as the request's failure so the
          // external clock's logs carry it (fail visibly, never a silent absorb).
          log.error(`[agentcore] schedule-fire ${name} failed: ${String(e)}`);
          return text(`schedule-fire failed: ${String(e)}\n`, 500);
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
        // The structured verdict (transport-200 — see the envelope doc).
        return json(
          constructionError === undefined
            ? { ok: true }
            : { ok: false, error: `channel construction failed: ${constructionError}` },
          200,
        );
      }
      case "invoke": {
        // Reuse the HTTP channel's handler wholesale (SSE, cancellation, backpressure) by handing it the shape it
        // already validates — one protocol, one implementation.
        const inner = new Request("http://agentcore.local/invoke", {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({ session: envelope.session, text: envelope.text }),
        });
        return invokeHandler(inner);
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

/** Thrown by the mount-site `fire` binding when the envelope names a schedule this workspace does not have. */
export class UnknownScheduleError extends Error {
  constructor(name: string) {
    super(`unknown schedule "${name}"`);
    this.name = "UnknownScheduleError";
  }
}
