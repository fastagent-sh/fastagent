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
import type { Agent } from "../agent.ts";
import type { StateSync } from "./agentcore-state.ts";
import { type AgentcoreEnvelope, ENVELOPE_KINDS, type WebhookReply } from "./agentcore-protocol.ts";
import { beginWork, onIdle } from "./busy.ts";
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
  /** The serving routes a direct deployment would mount (channels or the builtin invoke + health),
   *  built LAZILY: channel construction loads channel state and replays durable turn intent, so on
   *  AgentCore it must not run until the state root is authoritative — which happens at the first
   *  envelope's `stateSync.ready()` (the restore URLs only an envelope carries), never at boot, where
   *  the mount is pre-restore (empty after every version update). A factory, not a value: there is no
   *  moment during construction at which the right answer is knowable. May answer synchronously — the
   *  resolution chain normalizes it either way. */
  channels: () => Promise<RouteSurface> | RouteSurface;
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
  /** Cancels the adapter's process-global registrations. Without it a closed adapter keeps saving
   *  state on every later idle edge — including work belonging to whatever mounted after it. */
  signal?: AbortSignal;
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

/**
 * Build the AgentCore serving surface: `{ "POST /invocations", "GET /ping" }` — the whole of what the
 * platform routes into the container. The agent's own channels are not beside these: they are a table
 * inside the envelope dispatch below, reached only by unwrapping a forwarder envelope.
 */
/**
 * The process's BOOT, deferred to ingress. A resident host restores its state, wires its sinks and
 * constructs its channels at start-up; here nothing before the first trusted envelope is
 * authoritative (the mount is pre-restore, and the snapshot URLs only an envelope carries), so those
 * steps run against the first one and are asserted again on every later one. Two things happen ONCE
 * per process, in this order: the post-restore hook (the wake-alarm reconcile, which at boot would
 * read the mount the platform just wiped), and channel construction — whose outcome is cached EITHER
 * WAY. Success: the same resident channels a direct host keeps. Failure too: construction is an
 * ACTIVATION with side effects — loadChannels builds every healthy channel (starting its queues and
 * replaying durable turn intent) before reporting another module's failure — and there is no cleanup
 * contract to unwind it, so re-running it per envelope could replay the same recovered turn
 * concurrently. The first rejection is the process's answer: every later envelope fails with the same
 * message (visible each time), the retry boundary is a fresh session (which scale-to-zero provides
 * naturally), and the deploy driver's probe catches deterministic failures at deploy time.
 */
function createActivation(deps: {
  stateSync: StateSync | undefined;
  stateRoot: string;
  onStateReady: (() => void) | undefined;
  channels: AgentcoreAdapterOptions["channels"];
}): {
  /** Bring the state root up to date from what this envelope carries: refresh the snapshot URLs,
   *  restore (once — the sync memoizes it), persist the forwarder's URL, run the post-restore hook
   *  once. REJECTS when a snapshot exists but cannot be restored; the caller fails the request
   *  rather than serve an empty agent (and then snapshot that emptiness over the good copy). */
  restore(envelope: AgentcoreEnvelope): Promise<void>;
  /** The channel surface, constructed on first use after a restore; the outcome is cached either way. */
  channels(): Promise<ChannelHandler>;
} {
  const { stateSync, stateRoot, onStateReady } = deps;
  let warnedUnsnapshotted = false;
  let stateReadyFired = false;
  let dispatchP: Promise<ChannelHandler> | undefined;
  return {
    async restore(envelope) {
      if (stateSync) {
        if (envelope.state && typeof envelope.state.getUrl === "string" && typeof envelope.state.putUrl === "string") {
          stateSync.use(envelope.state);
        } else if (envelope.kind !== "invoke" && !stateSync.configured() && !warnedUnsnapshotted) {
          // webhook/schedule-fire/wake-poke/probe reach us ONLY through the forwarder, which mints the
          // pair. Missing = a broken/stale topology whose state dies at the next deploy: say so, loudly,
          // once per process (a direct `invoke` legitimately has none — its session storage is its own).
          warnedUnsnapshotted = true;
          log.warn(unsnapshottedWarning);
        }
        await stateSync.ready();
      }
      // The forwarder rides its public URL along on every envelope — persist it (write-if-changed) so
      // the wake-alarm sink can call back. AFTER the restore: a stale snapshot copy must not win over
      // the URL this deployment is actually reachable at. A bad persist must not fail the turn.
      if (typeof envelope.wake?.url === "string") {
        try {
          rememberWakeAlarmUrl(stateRoot, envelope.wake.url);
        } catch (e) {
          log.error(`[agentcore] could not persist the wake-alarm URL: ${String(e)}`);
        }
      }
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
  const { channels, agent, stateRoot, isBusy, fire, stateSync, ingressSecret, onStateReady } = options;
  const activation = createActivation({ stateSync, stateRoot, onStateReady, channels });
  const invokeHandler = createInvokeHandler(agent);
  // Snapshot on the 0-in-flight edge: webhook channels ACK fast and finish the turn in the
  // background, so "the request returned" is NOT when the state root settles.
  if (stateSync) {
    const off = onIdle(() => stateSync.save());
    options.signal?.addEventListener("abort", off, { once: true });
  }

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
    // and may NOT carry internal fields — riding a `state` or `wake` URL on a public invoke would
    // redirect the state snapshot (auth.json) or the alarm callback (the wake secret) to the caller.
    // Internal fields are DROPPED rather than rejected: a public caller has no business knowing them.
    const trusted = secretEquals(envelope.auth, ingressSecret);
    if (!trusted) {
      if (envelope.kind !== "invoke") {
        log.warn(`[agentcore] rejected an unauthenticated "${envelope.kind}" envelope`);
        return text("forbidden\n", 403);
      }
      envelope.wake = undefined;
      envelope.state = undefined;
    }
    // Cross-deploy state: the platform wipes /mnt/state on every version update, so the durable copy
    // must be pulled back BEFORE anything reads it.
    try {
      await activation.restore(envelope);
    } catch (e) {
      log.error(`[agentcore] state restore failed: ${String(e)}`);
      // The probe is the deploy driver's verification channel: its diagnostics must survive the
      // forwarder, which folds a non-200 transport into an opaque 502 — so for it the failure
      // rides a transport-200 structured verdict; every other kind keeps the plain 503.
      if (envelope.kind === "probe") return json({ ok: false, error: `state restore failed: ${String(e)}` }, 200);
      return text(`state restore failed: ${String(e)}\n`, 503);
    }
    // The channels come up on the first trusted ingress after the state root became authoritative —
    // whichever kind carries it, so a cold start woken by a schedule fire or an alarm poke still
    // replays checkpointed turn intent. Two deliberate exceptions: `checkpoint` must push state even
    // when a channel is broken, and a public `invoke` runs in its own isolated storage — constructing
    // against THAT root would cache pre-restore emptiness for the ingress session. Failure policy is
    // per kind below: webhook and wake-poke fail their request (503), the probe reports it
    // structurally, and a schedule fire proceeds — cron does not consume channels, and letting an
    // unrelated channel misconfiguration silence the clock would turn one fault into two (the error
    // is logged here either way).
    let constructionError: string | undefined;
    let dispatch: ChannelHandler | undefined;
    if (trusted && envelope.kind !== "checkpoint" && envelope.kind !== "invoke") {
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
        // the wake pump (boot drain + 30s poll) fires whatever is due. Nothing to dispatch — the
        // initialization above already resolved construction (replaying checkpointed turn intent),
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

  // Settle-then-snapshot: when the envelope leaves nothing in flight, its writes are final now (a
  // background turn instead reports through the idle edge above).
  //
  // A public `invoke` is the one kind this MISSES, measurably: it answers with an unconsumed SSE
  // stream, so the turn runs after this line and its records wait for the next envelope's snapshot.
  // Counting it as in-flight work would close that and cost more than it buys — the stream drains at
  // the CLIENT's pace, so one parked reader pins /ping at HealthyBusy and defeats the idle reclaim,
  // which is the quota-exhaustion failure the ping contract below warns about. The kinds that carry
  // conversations (webhook, schedule-fire, wake-poke) all run their turn inside the request or
  // through `beginWork`, so they land on one of the two edges; `invoke` is the direct/debug door.
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
