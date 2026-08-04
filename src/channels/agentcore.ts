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
 *    to {@link fireScheduleOnce}-shaped `fire` with the slot as the idempotency key (EventBridge
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
import { timingSafeEqual } from "node:crypto";
import type { Agent } from "../agent.ts";
import type { StateSync, StateUrls } from "./agentcore-state.ts";
import { beginWork, onIdle } from "./busy.ts";
import type { Routes } from "../host/node.ts";
import { router } from "../host/node.ts";
import { log } from "../log.ts";
import { rememberWakeAlarmUrl } from "../schedule/wake-alarm.ts";
import type { ScheduleFireOutcome } from "../schedule/scheduler.ts";
import { readBodyCapped } from "./body.ts";
import { createInvokeHandler } from "./http.ts";
import { text } from "./respond.ts";
import { MAX_ENVELOPE_BYTES, MAX_WEBHOOK_BODY_BYTES } from "./agentcore-limits.ts";

/**
 * The HOST's webhook body limit, and the one place it is computed. Lambda Function URLs cap a request
 * at 6 MB, so the forwarder cannot deliver more than that no matter what the adapter accepts; the
 * body arrives base64-encoded (×4/3) inside a JSON envelope, so the ORIGINAL body ceiling is smaller
 * still. This is a real capability difference from a resident host — the GitHub channel's own
 * contract is 25 MiB — so `deploy agentcore` says so at plan time rather than letting an oversized
 * payload surface as an opaque 502.
 */

/** What the forwarder Lambda / EventBridge deliver in the `/invocations` payload. Every kind may
 *  carry `wake` — the forwarder's self-resolved public URL, which the adapter persists so the wake
 *  ALARM sink (schedule/wake-alarm.ts) can call back without the URL being baked anywhere. */
export type AgentcoreEnvelope = {
  /** Shared secret proving this envelope came from the forwarder (FASTAGENT_INGRESS_SECRET). The
   *  public `invoke` data plane neither has nor needs it — and may not carry the fields below. */
  auth?: string;
  wake?: { url: string };
  state?: StateUrls;
} & (
  | {
      kind: "webhook";
      /** Original webhook request line, verbatim. `path` must be absolute ("/telegram"). */
      method: string;
      path: string;
      /** Original raw query string (no leading `?`) — "verbatim" includes it; a channel reading
       *  `request.url.searchParams` must see what the webhook sender sent. */
      query?: string;
      /** Original headers — signature material (secret tokens, Feishu signatures) rides here. */
      headers?: Record<string, string>;
      /** Original body, base64 (webhook bodies are JSON but the tunnel must be byte-exact). */
      bodyB64?: string;
    }
  | {
      kind: "schedule-fire";
      name: string;
      /** The cron instant this fire is FOR (ISO) — the slot-idempotency key. */
      slot: string;
    }
  | { kind: "invoke"; session: string; text: string }
  /** An EventBridge wake-up poke: the invocation ITSELF is the payload — it wakes the container,
   *  whose boot drain / 30s wake pump then fires whatever is due. The handler only acks. */
  | { kind: "wake-poke" }
  /** Pre-stop checkpoint (`--run`, right before stop-runtime-session): push the state snapshot NOW.
   *  A stop cuts an in-flight turn, and its durable turn intent — written pre-ACK by every replaying
   *  channel — lives on a mount the version update is about to erase. Flushing first is what makes
   *  "channels with replay re-run it" true rather than aspirational. */
  | { kind: "checkpoint" }
);

/** The webhook envelope's reply: the channel's real HTTP response, ridden inside a transport-200
 *  body so the forwarder can re-emit it verbatim (see the module header on AgentCore's 424 folding). */
export interface WebhookReply {
  status: number;
  headers: Record<string, string>;
  bodyB64: string;
}

export interface AgentcoreAdapterOptions {
  /** The serving routes a direct deployment would mount (channels or the builtin invoke + health). */
  routes: Routes;
  agent: Agent;
  /** Where the forwarder URL from envelopes is persisted for the wake-alarm sink (the state root). */
  stateRoot: string;
  /** Process-wide background-work signal (busy.ts `activeWork() > 0`) — injected for tests. */
  isBusy: () => boolean;
  /** Slot-idempotent schedule fire ({@link fireScheduleOnce} bound to this workspace's schedules);
   *  undefined when the workspace has none — a schedule-fire envelope then 404s (deploy drift: an
   *  external clock still firing for a schedule this definition no longer has). */
  fire?: (name: string, slot: Date) => Promise<ScheduleFireOutcome>;
  /** Cross-deploy state durability (agentcore-state.ts). Absent = the state root is local-only,
   *  which on AgentCore means it is erased by the next deploy — the serving path always wires it. */
  stateSync?: StateSync;
  /** FASTAGENT_INGRESS_SECRET: what makes an envelope the FORWARDER's rather than any IAM principal's.
   *  Undefined = nothing can be trusted, so only the public `invoke` kind is served. */
  ingressSecret?: string;
  /** Runs ONCE, after the state root is authoritative (post-restore) — the wake-alarm reconcile, which
   *  at boot would see the mount the platform just wiped and conclude there is nothing pending. */
  onStateReady?: () => void;
}

const unsnapshottedWarning =
  "[agentcore] this envelope carried no state-snapshot URLs — the state root is LOCAL ONLY and the " +
  "platform erases it on the next deploy (redeploy with a current fastagent to restore durability)";

const jsonHeaders = { "content-type": "application/json" } as const;
const json = (body: unknown, status: number): Response =>
  new Response(`${JSON.stringify(body)}\n`, { status, headers: jsonHeaders });

/** Compare an untrusted envelope secret without leaking a matching-prefix timing signal. */
function secretMatches(actual: unknown, expected: string | undefined): boolean {
  if (typeof actual !== "string" || expected === undefined) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

/**
 * Build the AgentCore serving surface: `{ "POST /invocations", "GET /ping" }`. The caller merges it
 * over its routes (collision-checked at the mount site, serve.ts) — the inner routes stay mounted
 * too, which is harmless (AgentCore routes only /invocations and /ping into the container) and keeps
 * a local `curl` debug surface.
 */
export function agentcoreRoutes(options: AgentcoreAdapterOptions): Routes {
  const { routes, agent, stateRoot, isBusy, fire, stateSync, ingressSecret, onStateReady } = options;
  const dispatch = router(routes);
  const invokeHandler = createInvokeHandler(agent);
  // Snapshot on the 0-in-flight edge: webhook channels ACK fast and finish the turn in the
  // background, so "the request returned" is NOT when the state root settles.
  if (stateSync) onIdle(() => stateSync.save());
  let warnedUnsnapshotted = false;
  let stateReadyFired = false;

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
      return text('need { "kind": "webhook" | "schedule-fire" | "invoke" | "wake-poke" | "checkpoint", ... }\n', 400);
    }
    // AUTHENTICATION BOUNDARY. `InvokeAgentRuntime` is an ordinary IAM action, so "reached this
    // handler" proves nothing about the sender. Only an envelope carrying the shared secret is the
    // forwarder's; anything else is the PUBLIC data plane, which may run exactly one kind (`invoke`)
    // and may NOT carry internal fields — riding a `state` or `wake` URL on a public invoke would
    // redirect the state snapshot (auth.json) or the alarm callback (the wake secret) to the caller.
    // Internal fields are DROPPED rather than rejected: a public caller has no business knowing them.
    const trusted = secretMatches(envelope.auth, ingressSecret);
    if (!trusted) {
      if (envelope.kind !== "invoke") {
        log.warn(`[agentcore] rejected an unauthenticated "${envelope.kind}" envelope`);
        return text("forbidden\n", 403);
      }
      envelope.wake = undefined;
      envelope.state = undefined;
    }
    // The forwarder rides its public URL along on every envelope — persist it (write-if-changed) so
    // the wake-alarm sink can call back. Written AFTER the restore below: a stale snapshot copy must
    // not win over the URL this deployment is actually reachable at. A bad persist must not fail the turn.
    const rememberUrl = (): void => {
      if (typeof envelope.wake?.url !== "string") return;
      try {
        rememberWakeAlarmUrl(stateRoot, envelope.wake.url);
      } catch (e) {
        log.error(`[agentcore] could not persist the wake-alarm URL: ${String(e)}`);
      }
    };
    // Cross-deploy state: the platform wipes /mnt/state on every version update, so the durable copy
    // must be pulled back BEFORE anything reads it. A failed restore fails the request — serving an
    // empty agent (and then snapshotting that emptiness over the good copy) is the worse outcome.
    if (stateSync) {
      if (envelope.state && typeof envelope.state.getUrl === "string" && typeof envelope.state.putUrl === "string") {
        stateSync.use(envelope.state);
      } else if (envelope.kind !== "invoke" && !stateSync.configured() && !warnedUnsnapshotted) {
        // webhook/schedule-fire/wake-poke reach us ONLY through the forwarder, which always mints the
        // pair. Missing = a broken/stale topology whose state dies at the next deploy: say so, loudly,
        // once per process (a direct `invoke` legitimately has none — its session storage is its own).
        warnedUnsnapshotted = true;
        log.warn(unsnapshottedWarning);
      }
      try {
        await stateSync.ready();
      } catch (e) {
        log.error(`[agentcore] state restore failed: ${String(e)}`);
        return text(`state restore failed: ${String(e)}\n`, 503);
      }
    }
    rememberUrl();
    // The state root is authoritative only now — anything that must READ it at startup (the wake-alarm
    // reconcile) runs here, once, rather than at boot against a mount the platform just wiped.
    if (onStateReady && !stateReadyFired) {
      stateReadyFired = true;
      onStateReady();
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
      case "checkpoint": {
        // Deliberately does NOT wait for idle: the durable turn intent is persisted BEFORE the
        // webhook ACK (turn-store.ts), so a flush right now already carries the interrupted turn —
        // and blocking a deploy on a turn that may run for minutes would be the worse trade.
        if (!stateSync) return json({ written: false, reason: "no state sync in this deployment" }, 200);
        try {
          // The reply is the ONLY thing telling the operator whether an in-flight turn was
          // protected, so it reports what actually happened — `written: false` (nothing to write)
          // reads differently from `written: true`, and a failure is a failure.
          return json(await stateSync.checkpoint(), 200);
        } catch (e) {
          log.error(`[agentcore] checkpoint failed: ${String(e)}`);
          return text(`checkpoint failed: ${String(e)}\n`, 500);
        }
      }
      case "wake-poke": {
        // The poke's job is DONE by arriving: the invocation woke (or kept awake) the container, and
        // the wake pump (boot drain + 30s poll) fires whatever is due. Nothing to dispatch.
        return json({ ok: true }, 200);
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

  // Settle-then-snapshot: when the envelope leaves nothing in flight, its writes are final now (a
  // background turn instead reports through the idle edge above).
  const invocations = async (req: Request): Promise<Response> => {
    const response = await handleInvocation(req);
    if (stateSync && !isBusy()) stateSync.save();
    return response;
  };

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
  return {
    "POST /invocations": invocations,
    "GET /ping": () => {
      const status = isBusy() ? "HealthyBusy" : "Healthy";
      if (status !== lastStatus) {
        lastTransition = Math.floor(Date.now() / 1000);
        log.debug(`[agentcore] ping status: ${lastStatus} → ${status}`);
        lastStatus = status;
      }
      return json({ status, time_of_last_update: lastTransition }, 200);
    },
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
