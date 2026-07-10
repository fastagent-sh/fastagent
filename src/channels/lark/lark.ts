/**
 * Lark/Feishu bot channel: verify the webhook (signature/decrypt or token) → answer url_verification →
 * dedup on message_id → decide via `route(event)` → run the turn → stream the agent's reply back as a
 * live card, ACK 200. Reply model A: the channel holds the app credentials and posts the reply itself
 * (chat UX), like the telegram channel. No SDK — inbound is a JSON POST, outbound is a `fetch` pipeline
 * (lark-api.ts; the tripwire for adopting the official SDK is documented there). The developer writes
 * only `route` (policy); the channel owns transport + format (markdown card) + attachments.
 *
 * This file is the Lark WIRING: ingress (verification, body cap, dedup) + the per-turn lifecycle +
 * composition. Every other concern lives in its own module, each owning its invariants:
 *   - crypto.ts        pure webhook security math: AES event decryption, request signature
 *   - parse.ts         pure event parsing: content decode, prompt envelope, summon/route policy
 *   - invoke-turn.ts   run one turn: resolve the reply referent + attachments, stream `agent.invoke`
 *   - ../turn-queue.ts in-memory per-session serial execution (FIFO; one turn at a time per session)
 *   - ../turn-store.ts durable turn intent (L1): pre-ACK persist, replay a crash-surviving turn
 *   - seen.ts          accepted-turn dedup ring (message_id — the platform documents duplicate pushes)
 *   - preview.ts       the live streaming-card pump + terminal-write policy (text-tier fallback)
 *   - card.ts          pure card JSON builders (streaming entity, settled card, entity content)
 *   - lark-api.ts      the single Open API pipeline (token cache, timeouts, rate-limit retry, code gate)
 *   - ../state.ts      atomic state files under the channel-state home
 *
 * Webhook mode only (v1): the event URL is configured by hand in the developer console (there is no
 * setWebhook API; the console's save performs the url_verification challenge this handler answers).
 * The WebSocket long-connection mode requires the official SDK and a non-HTTP ingress seam — a later
 * tier, noted in docs/lark.md.
 *
 * Group visibility is scope-gated ON THE PLATFORM: with the default `im:message.group_at_msg` scope
 * only @mentions of the bot are delivered at all; receiving every group message needs the sensitive
 * `im:message.group_msg` scope (admin approval). The telegram channel's un-summoned context buffer
 * therefore has no v1 counterpart here — it becomes worthwhile exactly when that scope is granted.
 *
 * Authored against the public `@fastagent-sh/fastagent` surface only (the contract + the channel-
 * authoring kit: readBodyCapped / text), like a third-party `fastagent-channel-*` package would be.
 */
import { isAbsolute, join } from "node:path";
import type { ChannelModule } from "../../host/node.ts";
import { log } from "../../log.ts";
import { readBodyCapped } from "../body.ts";
import { text } from "../respond.ts";
import { ensureStateHome } from "../state.ts";
import { createTurnQueue } from "../turn-queue.ts";
import { createTurnStore } from "../turn-store.ts";
import { decryptEvent, timingSafeEqualStr, verifySignature } from "./crypto.ts";
import { invokeLarkTurn } from "./invoke-turn.ts";
import { type LarkApi, type LarkTarget, createLarkApi } from "./lark-api.ts";
import {
  type LarkMessage,
  type LarkMessageEvent,
  type LarkRoute,
  defaultLarkRoute,
  larkEnvelope,
  parseContent,
  placeKey,
} from "./parse.ts";
import { type LarkFailure, defaultErrorMessage, streamLarkReply } from "./preview.ts";
import { createSeenRing } from "./seen.ts";

// Re-export the public surface authored elsewhere, so `@fastagent-sh/fastagent/lark` keeps one entry point.
export { defaultLarkRoute, larkEnvelope };
export type { LarkFailure, LarkMessage, LarkMessageEvent, LarkRoute };

/** Execution ceiling: a turn that has STARTED running this many times without finishing is dropped
 *  rather than run again (a poison turn must not loop forever under a restart policy). Counted per turn
 *  at dequeue, so a never-run turn queued behind a poison one keeps its full budget. */
const MAX_TURN_ATTEMPTS = 3;

/** Event body cap — events are small JSON; 1 MiB is generous and guards a public endpoint. */
const MAX_EVENT_BYTES = 1 << 20;

/** The persisted turn intent (what the runner needs to re-execute it). `seq` is the channel-assigned
 *  arrival number — lark message_ids (`om_…`) carry no order, so recovery sorts on this instead. */
interface StoredLarkTurn {
  id: string; // message_id (the dedup key the platform itself recommends)
  seq: number;
  session: string;
  baseText: string;
  chatId: string;
  replyTo?: string;
  replyInThread?: boolean;
  parentId?: string;
  images: { msg: string; key: string }[];
  files: { msg: string; key: string; name?: string }[];
  attempts: number;
}

/** State files are an IO boundary: valid JSON of the WRONG SHAPE must degrade like a corrupt file. */
function isStoredLarkTurn(t: unknown): t is StoredLarkTurn {
  const r = t as StoredLarkTurn;
  const refs = (v: unknown): boolean =>
    Array.isArray(v) &&
    v.every(
      (x) => typeof (x as { msg?: unknown }).msg === "string" && typeof (x as { key?: unknown }).key === "string",
    );
  return (
    typeof r?.id === "string" &&
    typeof r.seq === "number" &&
    typeof r.session === "string" &&
    typeof r.baseText === "string" &&
    typeof r.chatId === "string" &&
    (r.replyTo === undefined || typeof r.replyTo === "string") &&
    (r.replyInThread === undefined || typeof r.replyInThread === "boolean") &&
    (r.parentId === undefined || typeof r.parentId === "string") &&
    refs(r.images) &&
    refs(r.files) &&
    typeof r.attempts === "number"
  );
}

/** One accepted turn: the persisted intent plus live-only fields (never persisted — a restart's queue
 *  notice is gone, so a replayed turn mounts a fresh preview). */
interface PendingLarkTurn extends Omit<StoredLarkTurn, "attempts"> {
  /** The "⏳ queued" notice's message_id, when one was sent — deleted once the preview mounts. */
  noticeId?: string;
}

export interface LarkChannelOptions {
  /** App ID (developer console → Credentials & Basic Info). */
  appId: string;
  /** App Secret (same page) — drives the tenant_access_token the replies ride on. */
  appSecret: string;
  /** Verification Token (console → Events & Callbacks) — authenticates PLAINTEXT events. */
  verificationToken: string;
  /** Encrypt Key (same page, optional there — recommended): when set, events arrive encrypted and
   *  signed; this channel then REFUSES plaintext events (fail closed — accepting both would let a
   *  forger skip the stronger check). Must match the console exactly. */
  encryptKey?: string;
  /** Policy: whether/where to answer an event (return null to ignore). Defaults to {@link defaultLarkRoute}. */
  route?: (event: LarkMessageEvent) => LarkRoute | null;
  /** Customer-facing failure text for the chat (the dev-facing full `details` always go to the operator
   *  log). Return a string to send it, or undefined/"" to stay silent. Default: a neutral message keyed
   *  on `retryable`. A developer's own bot can surface the raw details, e.g. `(f) => `⚠️ ${f.details}``. */
  onError?: (failed: LarkFailure) => string | undefined;
  /** API origin. Default `https://open.feishu.cn` (Feishu); Lark international uses
   *  `https://open.larksuite.com`. */
  baseUrl?: string;
}

/**
 * Build a Lark/Feishu bot channel: policy options in, a {@link ChannelModule} out. The framework (or an
 * embedder) mounts it with the context — `larkChannel(opts)` in `channels/lark.ts` is the whole glue;
 * `agent` and the state root arrive via ctx, never through user code. Mounts `POST /lark` (the path to
 * configure as the console's event Request URL). One lark instance per workspace (single-process): the
 * state home is derived from the channel kind (`<stateRoot>/channels/lark`), so a second instance would
 * share the first's turn store/dedup ring.
 */
export function larkChannel({
  appId,
  appSecret,
  verificationToken,
  encryptKey,
  route,
  onError,
  baseUrl = "https://open.feishu.cn",
}: LarkChannelOptions): ChannelModule {
  // All three are mandatory: without the app credentials no reply can be sent; without the verification
  // token a plaintext-mode endpoint would accept forged events. Fail at construction (startup), not
  // silently at the first event.
  if (!appId || !appSecret) {
    throw new Error("larkChannel requires appId + appSecret (developer console → Credentials & Basic Info)");
  }
  if (!verificationToken) {
    throw new Error(
      "larkChannel requires a non-empty verificationToken (console → Events & Callbacks; an unset one accepts forged events)",
    );
  }
  return ({ agent, stateRoot }) => {
    const formatError = onError ?? defaultErrorMessage;
    const api: LarkApi = createLarkApi({ baseUrl, appId, appSecret });

    // One bot/v3/info at startup: the bot's open_id drives the default route's group @mention summon.
    // Until it resolves (or if it fails), group summon stays off — fail-closed — while p2p works.
    let botOpenId: string | undefined;
    void api.botInfo().then(
      (me) => {
        botOpenId = me.openId;
        if (!botOpenId) log.warn("[lark] bot/v3/info returned no open_id — group @mention summon stays off");
      },
      (e) => log.warn(`[lark] bot/v3/info failed; group @mention summon stays off until restart: ${String(e)}`),
    );
    const decide = route ?? ((event: LarkMessageEvent) => defaultLarkRoute(event, { botOpenId }));

    // The channel-state convention: this channel's durable home is `<stateRoot>/channels/lark`
    // (engine state at the root, channel state under `channels/<kind>/`) — derived, not an option, so
    // the operator's ONE state knob (FASTAGENT_STATE_DIR) can never be silently bypassed by glue.
    if (!isAbsolute(stateRoot)) {
      throw new Error(`larkChannel requires an absolute ctx.stateRoot, got "${stateRoot}"`);
    }
    const stateHome = join(stateRoot, "channels", "lark");
    ensureStateHome(stateHome); // create + self-ignore — downloaded files may carry chat content
    const store = createTurnStore<StoredLarkTurn>(join(stateHome, "turns.json"), {
      label: "[lark]",
      isRecord: isStoredLarkTurn,
      order: (a, b) => a.seq - b.seq,
    });
    const seen = createSeenRing(join(stateHome, "seen.json"));
    const toStored = (r: PendingLarkTurn): StoredLarkTurn => {
      const { noticeId: _live, ...intent } = r; // drop the live-only field; TS enforces the rest is complete
      return { ...intent, attempts: 0 };
    };

    const targetOf = (r: PendingLarkTurn): LarkTarget => ({
      chatId: r.chatId,
      replyTo: r.replyTo,
      replyInThread: r.replyInThread,
    });

    // In-memory: the in-flight "⏳ queued" notice per turn, awaited at dequeue so the turn reliably
    // knows the notice id (to delete it) instead of racing it and orphaning a late-arriving notice.
    const notices = new Map<string, Promise<void>>();
    const queue = createTurnQueue<PendingLarkTurn>({
      label: "[lark]",
      // Queue feedback: when this session already has a turn running/queued, a silent wait reads as
      // "the bot ignored me" once the current turn runs long — tell the asker NOW (reply-quoted, so it
      // is clear whose ask is queued). Best-effort and post-ACK: a failed notice is a log line, never a
      // failed event delivery. The preview then deletes this notice once its card mounts.
      onQueuedBehind: (rec) => {
        notices.set(
          rec.id,
          api.sendText(targetOf(rec), "⏳ Queued — I’ll start once the current task finishes.").then(
            (id) => {
              if (id !== undefined) rec.noticeId = id;
            },
            (e) => log.warn(`[lark] queue notice failed (the turn still runs): ${String(e)}`),
          ),
        );
      },
      run: async (rec) => {
        // Runs at DEQUEUE time (serialized). Settle the queue notice (if any) so rec.noticeId is final —
        // in the common path it resolved while the previous turn was still running, so this await is
        // instant. BEFORE the ceiling check so a dropped turn's notice is settled/cleared too.
        await notices.get(rec.id);
        notices.delete(rec.id);
        // Count this execution against the durable record (poison-turn ceiling) before running it again.
        const decision = store.startAttempt(rec.id, MAX_TURN_ATTEMPTS);
        if (decision === "exceeded") {
          notifyDropped(rec);
          return;
        }
        if (decision === "defer") {
          // Couldn't record the attempt (disk failure): skip this cycle; a restart replays it. Its "⏳"
          // notice (if any) would falsely read "Queued" forever — delete it best-effort (the eventual
          // replay mounts a fresh preview).
          if (rec.noticeId !== undefined) void api.deleteMessage(rec.noticeId).catch(() => {});
          return;
        }
        const startedAt = Date.now();
        log.info(`[lark] turn start: turn=${rec.id} session=${rec.session} chat=${rec.chatId}`);
        try {
          await streamLarkReply(
            invokeLarkTurn(
              agent,
              rec.session,
              rec.baseText,
              { api, chatId: rec.chatId, filesDir: join(stateHome, "files") },
              { images: rec.images, files: rec.files, parentId: rec.parentId },
              // On completed, drop the intent — the turn provably lives in the session from here on.
              () => store.remove(rec.id),
            ),
            api,
            targetOf(rec),
            formatError,
            rec.noticeId,
          );
          log.info(`[lark] turn done: turn=${rec.id} session=${rec.session} (${Date.now() - startedAt}ms)`);
        } catch (error) {
          log.error(
            `[lark] turn failed: turn=${rec.id} session=${rec.session} (${Date.now() - startedAt}ms): ${String(error)}`,
          );
        } finally {
          // Fallback removal for the caught-error paths (a `failed` event or a transport throw): those
          // never reach the completed hook above. Idempotent — a second remove is a no-op. Only an
          // INTERRUPTED run (this finally never runs — a crash or SIGTERM deploy) leaves the record for
          // replay; a transport throw is dropped, not retried (safe retry needs an L2 delivery key).
          store.remove(rec.id);
        }
      },
    });

    // Accept a turn: persist its intent (pre-ACK; a failed write throws → webhook 500 → redeliver),
    // record its id in the dedup ring (post-decision insurance, best-effort), enqueue it. Recovery
    // re-enqueues a crash-surviving turn WITHOUT re-persisting.
    const submit = (rec: PendingLarkTurn, persist: boolean): void => {
      if (persist) {
        store.add(toStored(rec));
        seen.add(rec.id);
      }
      queue.accept(rec);
    };

    // Tell the asker when a turn is dropped at the execution ceiling: the chain's end needs a signal,
    // not just an operator log line. Take over the "⏳ Queued" notice in place if the turn had one (else
    // send fresh) — leaving it pinned at "Queued" while sending a separate failure would double-post.
    const notifyDropped = (r: PendingLarkTurn): void => {
      const body = "⚠️ I couldn’t complete an earlier request — please ask again.";
      const sent =
        r.noticeId !== undefined
          ? api.editTextMessage(r.noticeId, body)
          : api.sendText(targetOf(r), body).then(() => {});
      void sent.catch((e) => log.warn(`[lark] could not notify a dropped turn (session=${r.session}): ${String(e)}`));
    };

    // Re-enqueue turns a prior crash left mid-flight (ACKed but unfinished). Synchronous at construction:
    // the queue runs them on the next tick. The execution ceiling is enforced per turn at dequeue.
    const recovered = store.recover();
    if (recovered.length > 0) log.info(`[lark] recovering ${recovered.length} unfinished turn(s) from a prior run`);
    let seqCounter = recovered.reduce((max, r) => Math.max(max, r.seq), 0);
    for (const { attempts: _a, ...intent } of recovered) submit({ ...intent, noticeId: undefined }, false);

    const handler = async (req: Request): Promise<Response> => {
      if (req.method !== "POST") return text("POST only\n", 405);
      const body = await readBodyCapped(req, MAX_EVENT_BYTES);
      if ("tooLarge" in body) return text("payload too large\n", 413);
      let outer: Record<string, unknown>;
      try {
        outer = JSON.parse(body.text) as Record<string, unknown>;
        if (typeof outer !== "object" || outer === null) throw new Error("not an object");
      } catch {
        return text("invalid json\n", 400);
      }

      // ── Verification. Two modes, decided by the CONSOLE's Encrypt Key setting, mirrored here. ──────
      let envelope: Record<string, unknown>;
      if (typeof outer.encrypt === "string") {
        if (!encryptKey) {
          log.error("[lark] received an ENCRYPTED event but no encryptKey is configured — set LARK_ENCRYPT_KEY");
          return text("encrypt key not configured\n", 400);
        }
        // Signature first (over the RAW body), then decrypt. Both fail closed.
        const sig = {
          timestamp: req.headers.get("x-lark-request-timestamp") ?? "",
          nonce: req.headers.get("x-lark-request-nonce") ?? "",
          signature: req.headers.get("x-lark-signature") ?? "",
        };
        if (!sig.signature || !verifySignature(encryptKey, sig, body.text)) return text("invalid signature\n", 401);
        try {
          envelope = JSON.parse(decryptEvent(encryptKey, outer.encrypt)) as Record<string, unknown>;
        } catch {
          return text("invalid encrypted payload\n", 400);
        }
      } else {
        if (encryptKey) {
          // With an Encrypt Key configured, a PLAINTEXT event can only be a forgery (or a console
          // mismatch — surfaced in the log): accepting it would let a sender skip the signature.
          log.warn("[lark] rejected a plaintext event while encryptKey is set (console mismatch, or a forgery)");
          return text("plaintext events not accepted\n", 401);
        }
        envelope = outer;
      }
      // The verification token authenticates plaintext events; on encrypted ones it is defense in depth
      // (v2 carries it in header.token, url_verification at the top level). Fail closed when absent.
      const token =
        (typeof envelope.token === "string" ? envelope.token : undefined) ??
        (typeof (envelope.header as Record<string, unknown> | undefined)?.token === "string"
          ? ((envelope.header as Record<string, unknown>).token as string)
          : undefined);
      if (!token || !timingSafeEqualStr(token, verificationToken)) return text("invalid token\n", 401);

      // ── The console's URL-verification challenge (fires when the operator saves the Request URL). ──
      if (envelope.type === "url_verification" && typeof envelope.challenge === "string") {
        return Response.json({ challenge: envelope.challenge });
      }

      // ── Events. Only im.message.receive_v1 is consumed; everything else is ACKed and dropped
      // (a non-2xx would just make the platform retry an event this channel will never act on). ──────
      const header = envelope.header as { event_type?: string } | undefined;
      if (header?.event_type !== "im.message.receive_v1") return new Response(null, { status: 200 });
      const event = (envelope.event ?? {}) as LarkMessageEvent;
      const m = event.message;
      if (!m?.message_id || !m.chat_id) return new Response(null, { status: 200 });
      if (seen.has(m.message_id)) return new Response(null, { status: 200 }); // duplicate push — already accepted

      const r = decide(event);
      if (!r) return new Response(null, { status: 200 });
      {
        const session = r.session ?? placeKey(m);
        const chatId = r.chatId ?? m.chat_id;
        // Reply to the summoning message in groups (threads the answer under the asker; stays inside a
        // topic); a 1:1 p2p chat needs no reply-quote. Only when the RESOLVED target is the message's own
        // chat: a route that redirects elsewhere must not quote a same-id message in the wrong place.
        const sameTarget = chatId === m.chat_id;
        const replyTo = m.chat_type !== "p2p" && sameTarget ? m.message_id : undefined;
        const content = parseContent(m);
        const baseText = r.text ?? larkEnvelope(event);
        if (baseText.trim() !== "" || content.imageKeys.length > 0 || content.fileRefs.length > 0) {
          submit(
            {
              id: m.message_id,
              seq: ++seqCounter,
              session,
              baseText,
              chatId,
              replyTo,
              replyInThread: replyTo !== undefined && m.thread_id !== undefined ? true : undefined,
              parentId: m.parent_id,
              images: content.imageKeys.map((key) => ({ msg: m.message_id, key })),
              files: content.fileRefs.map((f) => ({ msg: m.message_id, key: f.key, name: f.name })),
            },
            true,
          );
        }
      }
      // ACK immediately (the platform expects a fast 200; the turn may outlast it by minutes) —
      // lifecycle goes to stderr; after the 200 those lines are the operator's only signal.
      return new Response(null, { status: 200 });
    };
    // Test/observability seam: await the fire-and-forget turns this handler enqueues (see turn-queue).
    (handler as typeof handler & { turnsIdle?: () => Promise<void> }).turnsIdle = () => queue.idle();
    return { "POST /lark": handler };
  };
}
