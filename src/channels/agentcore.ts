/**
 * AWS AgentCore Runtime adapter: serve fastagent's whole HTTP surface through the Runtime's service
 * contract. AgentCore gives a container exactly TWO paths — `POST /invocations` (the only ingress,
 * reached via the SigV4 `InvokeAgentRuntime` API) and `GET /ping` (health) — and no public URL, so
 * the deployment fronts webhooks with a thin forwarder Lambda and delivers cron slots from
 * EventBridge Scheduler; both arrive here as an ENVELOPE in the /invocations payload:
 *
 *  - `{ kind: "webhook", method, path, headers?, bodyB64? }` — a verbatim webhook request captured
 *    by the forwarder. Reconstructed into a real `Request` and dispatched to the SAME channel routes
 *    a direct deployment serves — signature verification (Telegram secret token, Feishu signatures)
 *    runs unchanged inside the channel. The channel's HTTP response travels back INSIDE the
 *    transport reply (`{ status, headers, bodyB64 }`, transport always 200): AgentCore folds a
 *    container non-2xx into its own 424 RuntimeClientError, so riding the real status inside the
 *    envelope is the only way the forwarder can re-emit it verbatim (a Feishu URL-verification
 *    challenge needs the exact body + content-type back).
 *  - `{ kind: "schedule-fire", name, slot }` — one cron instant from the external clock. Dispatched
 *    to the bound `fire` callback with the slot as the idempotency key (EventBridge
 *    delivery is at-least-once; a duplicate slot must not double-fire).
 *  - `{ kind: "invoke", session, text }` — the programmatic data plane; streams the invoke back as
 *    SSE (AgentCore's streaming response form), reusing the HTTP channel's handler wholesale.
 *
 * `/ping` reports `HealthyBusy` (+ `time_of_last_update`, required — see the handler) while
 * process-wide background work is in flight (busy.ts) — webhook
 * channels ACK fast and run turns fire-and-forget, and AgentCore ends an idle session, so without
 * this signal a long turn would be killed mid-flight right after its ACK. `Healthy` when idle lets
 * the platform reclaim the microVM (that idle-to-zero IS the point of this deployment).
 */
import { Buffer } from "node:buffer";
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

/** What the lazy factory hands back: literal routes plus any prefix-owning mounts (the control
 *  plane), so the adapter's INNER dispatch is assembled exactly like a direct host's. */
export interface RouteSurface {
  routes: Routes;
  mounts?: readonly PrefixMount[];
}

export interface AgentcoreAdapterOptions {
  /** The channel surface. Construction may replay durable turn intent and runs once on trusted ingress. */
  channels: () => Promise<RouteSurface> | RouteSurface;
  agent: Agent;
  /** Where the forwarder URL from envelopes is persisted for the wake-alarm sink (the state root). */
  stateRoot: string;
  /** Process-wide background-work signal (busy.ts `activeWork() > 0`) — injected for tests. */
  isBusy: () => boolean;
  /** Slot-idempotent schedule fire, bound to this workspace's schedules;
   *  undefined when the workspace has none — a schedule-fire envelope then 404s (deploy drift: an
   *  external clock still firing for a schedule this definition no longer has). */
  fire?: (name: string, slot: Date) => Promise<ScheduleFireOutcome>;
  /** FASTAGENT_INGRESS_SECRET: what makes an envelope the FORWARDER's rather than any IAM principal's.
   *  Undefined = nothing can be trusted, so only the public `invoke` kind is served. */
  ingressSecret?: string;
  /** Runs once on activation, after accepting the current forwarder callback URL. */
  onStateReady?: () => void;
}

const jsonHeaders = { "content-type": "application/json" } as const;
const json = (body: unknown, status: number): Response =>
  new Response(`${JSON.stringify(body)}\n`, { status, headers: jsonHeaders });

/** Channel construction may already have replayed work before failing; cache either outcome to avoid replaying twice. */
function createActivation(deps: {
  stateRoot: string;
  onStateReady: (() => void) | undefined;
  channels: AgentcoreAdapterOptions["channels"];
}): {
  prepare(envelope: AgentcoreEnvelope): Promise<void>;
  /** The channel surface; the construction outcome is cached either way. */
  channels(): Promise<ChannelHandler>;
} {
  const { stateRoot, onStateReady } = deps;
  let stateReadyFired = false;
  let dispatchP: Promise<ChannelHandler> | undefined;
  return {
    async prepare(envelope) {
      // Use the current callback URL rather than the one persisted by an earlier deployment. A write
      // failure propagates: alarms would keep calling the previous deployment's forwarder.
      if (typeof envelope.wake?.url === "string") rememberWakeAlarmUrl(stateRoot, envelope.wake.url);
      if (onStateReady && !stateReadyFired) {
        stateReadyFired = true;
        onStateReady();
      }
    },
    channels() {
      if (!dispatchP) {
        // The factory runs INSIDE the chain: a synchronous throw must land in the cached rejection,
        // not escape before `dispatchP` is assigned (which would silently re-run the activation).
        dispatchP = Promise.resolve()
          .then(deps.channels)
          .then((surface) => router(surface.routes, surface.mounts));
        dispatchP.catch(() => {}); // observed here so the CACHED rejection is never "unhandled"
      }
      return dispatchP;
    },
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
    // AUTHENTICATION BOUNDARY. `InvokeAgentRuntime` is an ordinary IAM action, so "reached this
    // handler" proves nothing about the sender. Only an envelope carrying the shared secret is the
    // forwarder's; anything else is the PUBLIC data plane, which may run exactly one kind (`invoke`)
    // and may NOT redirect the alarm callback, which carries the wake secret.
    // Internal fields are DROPPED rather than rejected: a public caller has no business knowing them.
    const trusted = secretEquals(envelope.auth, ingressSecret);
    if (!trusted) {
      if (envelope.kind !== "invoke") {
        log.warn(`[agentcore] rejected an unauthenticated "${envelope.kind}" envelope`);
        return text("forbidden\n", 403);
      }
      envelope.wake = undefined;
    }
    try {
      if (trusted) await activation.prepare(envelope);
    } catch (e) {
      log.error(`[agentcore] activation failed: ${String(e)}`);
      // The probe is the deploy driver's verification channel: its diagnostics must survive the
      // forwarder, which folds a non-200 transport into an opaque 502 — so for it the failure
      // rides a transport-200 structured verdict; every other kind keeps the plain 503.
      if (envelope.kind === "probe") return json({ ok: false, error: `activation failed: ${String(e)}` }, 200);
      return text(`activation failed: ${String(e)}\n`, 503);
    }
    // Public invokes do not activate channels. A broken channel fails webhook/wake traffic and
    // the deployment probe, while independent scheduled work can still proceed.
    let constructionError: string | undefined;
    let dispatch: ChannelHandler | undefined;
    if (trusted && envelope.kind !== "invoke") {
      try {
        dispatch = await activation.channels();
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
        // A construction failure is the request's failure (503 through the forwarder, so the
        // platform retries and the operator sees the message), never a silently-empty channel.
        if (!dispatch) return text(`channel construction failed: ${constructionError ?? "unavailable"}\n`, 503);
        const response = await dispatch(inner);
        // Buffer the channel's ACK (webhook ACKs are small by design — the turn itself runs
        // fire-and-forget) and ride it inside the transport reply, byte-exact.
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
        // No fire capability (no schedules in this definition) or an unknown name is deploy drift —
        // an external clock rule outliving the schedule it fired for. 404 keeps it VISIBLE in the
        // clock's logs (a 200 would silently absorb every future fire).
        if (!fire) return text(`no schedules in this deployment (schedule-fire "${name}")\n`, 404);
        // The whole agent turn runs inside this request — but the CALLER (the forwarder Lambda) may
        // time out and drop the connection while the turn keeps running server-side. Count it as
        // in-flight work so /ping holds the session (HealthyBusy) for the remainder.
        const workDone = beginWork();
        try {
          const outcome = await fire(name, new Date(slot));
          return json(outcome, 200);
        } catch (e) {
          if (e instanceof UnknownScheduleError) return text(`${e.message}\n`, 404);
          // A claim-state fault (unreadable/unwritable fires.json) — surface it as the request's
          // failure so the external clock's logs carry it (fail visibly, never a silent absorb).
          log.error(`[agentcore] schedule-fire ${name} failed: ${String(e)}`);
          return text(`schedule-fire failed: ${String(e)}\n`, 500);
        } finally {
          workDone();
        }
      }
      case "wake-poke": {
        // The poke's job is DONE by arriving: the invocation woke (or kept awake) the container, and
        // the wake pump (boot drain + 30s poll) fires whatever is due. Nothing to dispatch — the
        // initialization above already resolved construction (replaying durable turn intent),
        // and its failure is this request's failure so the alarm's log line names it.
        if (constructionError !== undefined) return text(`channel construction failed: ${constructionError}\n`, 503);
        return json({ ok: true }, 200);
      }
      case "probe": {
        // The structured verdict (transport-200 — see the envelope doc): the deploy driver reads it
        // through the forwarder's reserved path, so the error text survives the hop that turns any
        // non-200 transport into an opaque 502.
        return json(
          constructionError === undefined
            ? { ok: true }
            : { ok: false, error: `channel construction failed: ${constructionError}` },
          200,
        );
      }
      case "invoke": {
        // Reuse the HTTP channel's handler wholesale (SSE, cancellation, backpressure) by handing it
        // the shape it already validates — one protocol, one implementation.
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
  // The Runtime ping contract: Healthy = reclaimable, HealthyBusy = keep the session alive
  // (background turns in flight). `time_of_last_update` is REQUIRED for the keep-alive to work,
  // despite the contract documenting it as optional ("If you omit the field, the platform tracks
  // status changes on its own"): measured on a live Runtime (us-east-1, 2026-08-04), the platform's
  // idle measurement reads ONLY this field — with it omitted, a session polling every ~2s and
  // receiving HealthyBusy 200s was still reclaimed at exactly IdleRuntimeSessionTimeout after the
  // last InvokeAgentRuntime, mid-turn, 2s after the last HealthyBusy answer; with the field present
  // the same turn survived 3.5× the idle timeout with zero invocations and completed. The value
  // updates ONLY on a real status change: a timestamp advancing on every ping declares a perpetual
  // status change, so the idle timeout never fires and dead-idle sessions live to MaxLifetime
  // (quota exhaustion — the failure mode the contract's warning describes).
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

/** Thrown by the mount-site `fire` binding when the envelope names a schedule this workspace does
 *  not have — the adapter maps it to 404 (deploy drift stays visible in the external clock's logs). */
export class UnknownScheduleError extends Error {
  constructor(name: string) {
    super(`unknown schedule "${name}"`);
    this.name = "UnknownScheduleError";
  }
}
