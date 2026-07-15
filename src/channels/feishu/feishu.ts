/**
 * Canonical Feishu bot-channel engine: verify webhook → answer url_verification → route → persist → run
 * the turn → stream a live card → ACK 200. Feishu (open.feishu.cn) is the reference cloud. Lark
 * international binds this engine through an explicit compatibility profile because its control plane
 * trails Feishu; protocol reuse does not make Lark the design center.
 *
 * The channel kind remains the unit of route, env namespace, state home, logs, and onboarding, so one
 * workspace may mount both without sharing state. Webhook mode only; WebSocket long connection needs
 * the official SDK and a non-HTTP ingress seam. See docs/feishu.md.
 */
import { isAbsolute, join } from "node:path";
import type { ChannelModule } from "../../host/node.ts";
import { log } from "../../log.ts";
import { readBodyCapped } from "../body.ts";
import { text } from "../respond.ts";
import { ensureStateHome } from "../state.ts";
import { createTurnQueue } from "../turn-queue.ts";
import { createTurnStore } from "../turn-store.ts";
import { FEISHU_CLOUD, type FeishuCloudProfile } from "./cloud.ts";
import { decryptEvent, timingSafeEqualStr, verifySignature } from "./crypto.ts";
import { invokeFeishuTurn } from "./invoke-turn.ts";
import { type FeishuApi, type FeishuTarget, createFeishuApi } from "./feishu-api.ts";
import type { FeishuEventHeader } from "./model.ts";
import { normalizeFeishuMessage } from "./normalize.ts";
import {
  type FeishuMessage,
  type FeishuMessageEvent,
  type FeishuRoute,
  cloudEnvelope,
  defaultFeishuRoute,
  feishuEnvelope,
  placeKey,
} from "./parse.ts";
import {
  type FeishuFailure,
  type MountedFeishuPreview,
  defaultErrorMessage,
  mountFeishuPreview,
  settleFeishuPreview,
  streamFeishuReply,
} from "./preview.ts";

// Canonical public surface; the Lark subpath aliases these types/functions at its compatibility boundary.
export { defaultFeishuRoute, feishuEnvelope };
export type { FeishuFailure, FeishuMessage, FeishuMessageEvent, FeishuRoute };

/** Execution ceiling: a turn that has STARTED running this many times without finishing is dropped
 *  rather than run again (a poison turn must not loop forever under a restart policy). Counted per turn
 *  at dequeue, so a never-run turn queued behind a poison one keeps its full budget. */
const MAX_TURN_ATTEMPTS = 3;

/** Event body cap — events are small JSON; 1 MiB is generous and guards a public endpoint. */
const MAX_EVENT_BYTES = 1 << 20;

/** Queue feedback is immediate by default: it is the user's acknowledgement that this exact ask was
 *  accepted behind another turn. The same reply-quoted card becomes the preview/final answer, so there
 *  is no extra message or recall tombstone to avoid. Authors may still configure a delay explicitly. */
const QUEUE_NOTICE_DELAY_MS = 0;

const QUEUED_PLACEHOLDER = "⏳ Queued — I’ll start once the current task finishes.";
const DEFERRED_PLACEHOLDER = "⏳ Delayed by a temporary system issue — I’ll retry automatically.";

/** The persisted turn intent (what the runner needs to re-execute it). `seq` is the channel-assigned
 *  arrival number — Feishu message_ids (`om_…`) carry no order, so recovery sorts on this instead. */
interface StoredFeishuTurn {
  id: string; // message_id (the platform delivery identity; seq below carries arrival order)
  seq: number;
  session: string;
  baseText: string;
  chatId: string;
  replyTo?: string;
  /** Source message to quote when queue feedback mounts. Unlike `replyTo`, this is also set for a p2p
   *  turn: each queued card must identify its own ask even though ordinary p2p answers are unquoted. */
  queueReplyTo?: string;
  replyInThread?: boolean;
  parentId?: string;
  images: { msg: string; key: string }[];
  files: { msg: string; key: string; name?: string }[];
  attempts: number;
}

/** State files are an IO boundary: valid JSON of the WRONG SHAPE must degrade like a corrupt file. */
function isStoredFeishuTurn(t: unknown): t is StoredFeishuTurn {
  const r = t as StoredFeishuTurn;
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
    (r.queueReplyTo === undefined || typeof r.queueReplyTo === "string") &&
    (r.replyInThread === undefined || typeof r.replyInThread === "boolean") &&
    (r.parentId === undefined || typeof r.parentId === "string") &&
    refs(r.images) &&
    refs(r.files) &&
    typeof r.attempts === "number"
  );
}

/** One accepted turn: the persisted intent plus live-only fields. The mounted queue card/text is not
 *  persisted; a replayed turn mounts a fresh preview because an old card may have expired. */
interface PendingFeishuTurn extends Omit<StoredFeishuTurn, "attempts"> {
  /** The queue-status card/text, when its delayed mount fired. The turn's preview takes it over. */
  preview?: MountedFeishuPreview;
}

export interface FeishuChannelOptions {
  /** App ID (developer console → Credentials & Basic Info). */
  appId: string;
  /** App Secret (same page) — drives the tenant_access_token the replies ride on. */
  appSecret: string;
  /** Verification Token (console → Events & Callbacks) — authenticates PLAINTEXT events. */
  verificationToken: string;
  /** Encrypt Key (same page, optional there — recommended): when set, ordinary events arrive encrypted
   *  and signed; this channel then REFUSES plaintext events (fail closed — accepting both would let a
   *  forger skip the stronger check). Feishu explicitly excludes the encrypted `url_verification`
   *  handshake from event signature verification; that narrow path is authenticated after decryption
   *  by the Verification Token. Must match the console exactly. */
  encryptKey?: string;
  /** Direct-message context + delivery policy. `threaded` (default) gives every top-level p2p message
   * its own session, creates a platform thread for the answer, and routes later thread messages back
   * by root message id. `continuous` keeps one session per p2p chat and sends ordinary unquoted replies. */
  directMessageSession?: "continuous" | "threaded";
  /** Group-message context + delivery policy. `threaded` (default) gives every top-level summoned
   * message its own session and platform thread; later messages in that thread return to the root
   * session. `continuous` preserves the legacy chat/topic sessions (`chat_id` / `chat_id:thread_id`). */
  groupMessageSession?: "continuous" | "threaded";
  /** Policy: whether/where to answer an event (return null to ignore). Defaults to {@link defaultFeishuRoute}. */
  route?: (event: FeishuMessageEvent) => FeishuRoute | null;
  /** Customer-facing failure text for the chat (the dev-facing full `details` always go to the operator
   *  log). Return a string to send it, or undefined/"" to stay silent. Default: a neutral message keyed
   *  on `retryable`. A developer's own bot can surface the raw details, e.g. `(f) => `⚠️ ${f.details}``. */
  onError?: (failed: FeishuFailure) => string | undefined;
  /** API origin override (tests / self-hosted gateways). The kind fixes the default —
   *  `feishuChannel` → `https://open.feishu.cn`, `larkChannel` → `https://open.larksuite.com`. */
  baseUrl?: string;
  /** How long (ms) a turn waits before its reply-quoted "⏳ Queued" card mounts. Defaults to 0
   *  (immediate); the same card is later taken over by the live preview/final answer. */
  queueNoticeDelayMs?: number;
}

/** Build the canonical Feishu channel. Lark calls the internal profile-bound builder below. */
export function feishuChannel(opts: FeishuChannelOptions): ChannelModule {
  return buildFeishuChannel(FEISHU_CLOUD, opts, feishuChannel.name);
}

/** Internal compatibility seam: protocol behavior comes from Feishu; the profile binds cloud edges. */
export function buildFeishuChannel(
  profile: FeishuCloudProfile,
  {
    appId,
    appSecret,
    verificationToken,
    encryptKey,
    directMessageSession = "threaded",
    groupMessageSession = "threaded",
    route,
    onError,
    baseUrl = profile.apiBase,
    queueNoticeDelayMs = QUEUE_NOTICE_DELAY_MS,
  }: FeishuChannelOptions,
  factoryName: string,
): ChannelModule {
  const { kind, envPrefix } = profile;
  const label = `[${kind}]`;
  // All three are mandatory: without the app credentials no reply can be sent; without the verification
  // token a plaintext-mode endpoint would accept forged events. Fail at construction (startup), not
  // silently at the first event.
  if (!appId || !appSecret) {
    throw new Error(`${factoryName} requires appId + appSecret (developer console → Credentials & Basic Info)`);
  }
  if (!verificationToken) {
    throw new Error(
      `${factoryName} requires a non-empty verificationToken (console → Events & Callbacks; an unset one accepts forged events)`,
    );
  }
  if (directMessageSession !== "continuous" && directMessageSession !== "threaded") {
    throw new Error(`${factoryName} directMessageSession must be "continuous" or "threaded"`);
  }
  if (groupMessageSession !== "continuous" && groupMessageSession !== "threaded") {
    throw new Error(`${factoryName} groupMessageSession must be "continuous" or "threaded"`);
  }
  return ({ agent, stateRoot }) => {
    const formatError = onError ?? defaultErrorMessage;
    const api: FeishuApi = createFeishuApi({ kind, baseUrl, appId, appSecret });

    // One bot/v3/info at startup: the bot's open_id drives the default route's group @mention summon.
    // Until it resolves (or if it fails), group summon stays off — fail-closed — while p2p works.
    let botOpenId: string | undefined;
    void api.botInfo().then(
      (me) => {
        botOpenId = me.openId;
        if (!botOpenId) log.warn(`${label} bot/v3/info returned no open_id — group @mention summon stays off`);
      },
      (e) => log.warn(`${label} bot/v3/info failed; group @mention summon stays off until restart: ${String(e)}`),
    );
    const decide = route ?? ((event: FeishuMessageEvent) => defaultFeishuRoute(event, { botOpenId }));

    // The channel-state convention: this channel's durable home is `<stateRoot>/channels/<kind>`
    // (engine state at the root, channel state under `channels/<kind>/`) — derived, not an option, so
    // the operator's ONE state knob (FASTAGENT_STATE_DIR) can never be silently bypassed by glue.
    if (!isAbsolute(stateRoot)) {
      throw new Error(`${factoryName} requires an absolute ctx.stateRoot, got "${stateRoot}"`);
    }
    const stateHome = join(stateRoot, "channels", kind);
    ensureStateHome(stateHome); // create + self-ignore — downloaded files may carry chat content
    const store = createTurnStore<StoredFeishuTurn>(join(stateHome, "turns.json"), {
      label,
      isRecord: isStoredFeishuTurn,
      order: (a, b) => a.seq - b.seq,
    });
    const toStored = (r: PendingFeishuTurn): StoredFeishuTurn => {
      const { preview: _live, ...intent } = r; // drop the live-only field; TS enforces the rest is complete
      return { ...intent, attempts: 0 };
    };

    const targetOf = (r: PendingFeishuTurn): FeishuTarget => ({
      chatId: r.chatId,
      replyTo: r.replyTo,
      replyInThread: r.replyInThread,
    });
    const queueTargetOf = (r: PendingFeishuTurn): FeishuTarget => ({
      chatId: r.chatId,
      replyTo: r.queueReplyTo,
      replyInThread: r.replyInThread,
    });

    // In-memory: the pending queue-preview mount per turn. Immediate by default; with an explicit delay,
    // it mounts only if the turn is still waiting when the timer fires and is cancelled unsent otherwise.
    // `done` settles either way, awaited at dequeue so the runner reliably receives the mounted preview
    // instead of racing it and double-posting.
    const notices = new Map<string, { cancel: () => void; done: Promise<void> }>();
    const queue = createTurnQueue<PendingFeishuTurn>({
      label,
      // Queue feedback: when this session already has a turn running/queued, a silent wait reads as
      // "the bot ignored me" once the current turn runs long — mount that turn's preview early with a
      // queue status. It reply-quotes the exact source message (including p2p), then the runner mutates
      // the SAME card/text into Thinking → final answer. Best-effort and post-ACK: a failed mount is a
      // log line, never a failed event delivery; the turn later mounts its normal preview.
      onQueuedBehind: (rec) => {
        let fired = false;
        let settle: () => void = () => {};
        const done = new Promise<void>((resolve) => {
          settle = resolve;
        });
        const mount = (): void => {
          fired = true;
          mountFeishuPreview(api, queueTargetOf(rec), QUEUED_PLACEHOLDER, label)
            .then(
              (preview) => {
                rec.preview = preview;
              },
              (e) => log.warn(`${label} queue preview failed (the turn still runs): ${String(e)}`),
            )
            .finally(settle);
        };
        const timer = queueNoticeDelayMs > 0 ? setTimeout(mount, queueNoticeDelayMs) : undefined;
        if (timer === undefined) mount();
        notices.set(rec.id, {
          // Cancel is a no-op once mounting started — the send is in flight and `done` settles with it.
          cancel: () => {
            if (!fired) {
              if (timer !== undefined) clearTimeout(timer);
              settle();
            }
          },
          done,
        });
      },
      run: async (rec) => {
        // Runs at DEQUEUE time (serialized). The turn's queue wait is over: cancel a not-yet-mounted
        // preview (fast turnover skips the Queued frame), then settle so rec.preview is final — in the
        // common path this await is instant. BEFORE the ceiling check so drop/defer can take it over too.
        const notice = notices.get(rec.id);
        notice?.cancel();
        await notice?.done;
        notices.delete(rec.id);
        // Count this execution against the durable record (poison-turn ceiling) before running it again.
        const decision = store.startAttempt(rec.id, MAX_TURN_ATTEMPTS);
        if (decision === "exceeded") {
          notifyDropped(rec);
          return;
        }
        if (decision === "defer") {
          // Couldn't record the attempt (disk failure): skip this cycle; a restart replays it. Do not
          // recall an existing queue preview (the client exposes a confusing tombstone): settle it in
          // place to an honest delayed status. The eventual replay mounts a fresh preview.
          if (rec.preview !== undefined) {
            void settleFeishuPreview(api, targetOf(rec), rec.preview, DEFERRED_PLACEHOLDER).catch((e) =>
              log.warn(`${label} could not update a deferred turn's queue preview: ${String(e)}`),
            );
          }
          return;
        }
        const startedAt = Date.now();
        log.info(`${label} turn start: turn=${rec.id} session=${rec.session} chat=${rec.chatId}`);
        try {
          await streamFeishuReply(
            invokeFeishuTurn(
              agent,
              rec.session,
              rec.baseText,
              { api, chatId: rec.chatId, filesDir: join(stateHome, "files"), label },
              { images: rec.images, files: rec.files, parentId: rec.parentId },
              // On completed, drop the intent — the turn provably lives in the session from here on.
              () => store.remove(rec.id),
            ),
            api,
            targetOf(rec),
            formatError,
            rec.preview,
            label,
          );
          log.info(`${label} turn done: turn=${rec.id} session=${rec.session} (${Date.now() - startedAt}ms)`);
        } catch (error) {
          log.error(
            `${label} turn failed: turn=${rec.id} session=${rec.session} (${Date.now() - startedAt}ms): ${String(error)}`,
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

    // Accept a turn: persist its intent before the ACK, then enqueue it. This deliberately shares
    // Telegram's L1 semantics: turns.json tracks unfinished work but there is no channel-specific
    // completed-delivery ledger. Recovery re-enqueues a crash survivor without re-persisting it.
    const submit = (rec: PendingFeishuTurn, persist: boolean): void => {
      if (persist) store.add(toStored(rec)); // failed write → webhook 500 → platform redelivery
      queue.accept(rec);
    };

    // Tell the asker when a turn is dropped at the execution ceiling: the chain's end needs a signal,
    // not just an operator log line. Take over its queue preview in place if present (else send fresh) —
    // leaving it pinned at "Queued" while sending a separate failure would double-post.
    const notifyDropped = (r: PendingFeishuTurn): void => {
      const body = "⚠️ I couldn’t complete an earlier request — please ask again.";
      void settleFeishuPreview(api, targetOf(r), r.preview, body).catch((e) =>
        log.warn(`${label} could not notify a dropped turn (session=${r.session}): ${String(e)}`),
      );
    };

    // Re-enqueue turns a prior crash left mid-flight (ACKed but unfinished). Synchronous at construction:
    // the queue runs them on the next tick. The execution ceiling is enforced per turn at dequeue.
    const recovered = store.recover();
    if (recovered.length > 0) log.info(`${label} recovering ${recovered.length} unfinished turn(s) from a prior run`);
    let seqCounter = recovered.reduce((max, r) => Math.max(max, r.seq), 0);
    for (const { attempts: _a, ...intent } of recovered) submit({ ...intent, preview: undefined }, false);

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
          log.error(
            `${label} received an ENCRYPTED event but no encryptKey is configured — set ${envPrefix}_ENCRYPT_KEY`,
          );
          return text("encrypt key not configured\n", 400);
        }
        const sig = {
          timestamp: req.headers.get("x-lark-request-timestamp") ?? "",
          nonce: req.headers.get("x-lark-request-nonce") ?? "",
          signature: req.headers.get("x-lark-signature") ?? "",
        };
        // Ordinary encrypted events MUST verify the signature over the raw body before decryption.
        // Feishu's documented exception is Request URL verification: its encrypted challenge carries
        // no event-signature headers, so it is decrypted first and admitted ONLY when its type is
        // url_verification; the common constant-time Token check below then authenticates it.
        if (sig.signature && !verifySignature(encryptKey, sig, body.text)) {
          log.warn(`${label} rejected an event: invalid X-Lark-Signature (encrypt key mismatch, or a forgery)`);
          return text("invalid signature\n", 401);
        }
        try {
          envelope = JSON.parse(decryptEvent(encryptKey, outer.encrypt)) as Record<string, unknown>;
        } catch {
          if (!sig.signature) {
            log.warn(`${label} rejected an unsigned encrypted request that could not be decrypted`);
            return text("invalid encrypted payload\n", 401);
          }
          return text("invalid encrypted payload\n", 400);
        }
        if (!sig.signature && envelope.type !== "url_verification") {
          log.warn(`${label} rejected an encrypted event: missing X-Lark-Signature`);
          return text("invalid signature\n", 401);
        }
      } else {
        if (encryptKey) {
          // With an Encrypt Key configured, a PLAINTEXT event can only be a forgery (or a console
          // mismatch — surfaced in the log): accepting it would let a sender skip the signature.
          log.warn(`${label} rejected a plaintext event while encryptKey is set (console mismatch, or a forgery)`);
          return text("plaintext events not accepted\n", 401);
        }
        envelope = outer;
      }
      // The Verification Token authenticates plaintext mode and the platform-documented unsigned,
      // encrypted URL challenge; on signed encrypted events it is defense in depth. V2 events carry it
      // in header.token, while url_verification carries it at the top level. Fail closed when absent.
      const token =
        (typeof envelope.token === "string" ? envelope.token : undefined) ??
        (typeof (envelope.header as Record<string, unknown> | undefined)?.token === "string"
          ? ((envelope.header as Record<string, unknown>).token as string)
          : undefined);
      if (!token || !timingSafeEqualStr(token, verificationToken)) {
        // Loud on purpose: the send side gets an opaque 401 and the platform just retries — this line is
        // the operator's ONLY signal that LARK_VERIFICATION_TOKEN does not match the console.
        log.warn(
          `${label} rejected an event: verification token mismatch (check ${envPrefix}_VERIFICATION_TOKEN against the console)`,
        );
        return text("invalid token\n", 401);
      }

      // ── The console's URL-verification challenge (fires when the operator saves the Request URL). ──
      if (envelope.type === "url_verification" && typeof envelope.challenge === "string") {
        // The console fires this when the operator saves the Request URL; without this line a PASSING
        // handshake is invisible and "did the challenge even arrive?" becomes guesswork.
        log.info(`${label} answered the console's url_verification challenge`);
        return Response.json({ challenge: envelope.challenge });
      }

      // ── Events. Only im.message.receive_v1 is consumed; everything else is ACKed and dropped
      // (a non-2xx would just make the platform retry an event this channel will never act on). ──────
      const header = envelope.header as FeishuEventHeader | undefined;
      if (header?.event_type !== "im.message.receive_v1") {
        log.debug(`${label} ignoring event type ${header?.event_type ?? "(none)"}`);
        return new Response(null, { status: 200 });
      }
      const event = (envelope.event ?? {}) as FeishuMessageEvent;
      const m = event.message;
      if (!m?.message_id || !m.chat_id) return new Response(null, { status: 200 });

      const r = decide(event);
      if (!r) {
        log.debug(`${label} not summoned — ignoring message ${m.message_id} (chat ${m.chat_id}, ${m.chat_type})`);
        return new Response(null, { status: 200 });
      }
      {
        const normalized = normalizeFeishuMessage(event, { cloud: kind, appId, header, botOpenId });
        if (!normalized) return new Response(null, { status: 200 });
        const threadedP2p = directMessageSession === "threaded" && m.chat_type === "p2p";
        const threadedGroup = groupMessageSession === "threaded" && m.chat_type === "group";
        const threadedConversation = threadedP2p || threadedGroup;
        // A top-level threaded message has no thread_id yet. Its tenant-unique message_id is therefore
        // the only identity available both before and after the first reply creates the thread.
        // Continuations carry that same value as root_id (field-verified on Feishu p2p; shared protocol
        // shape for groups/Lark). Prefix with the channel kind to isolate Feishu/Lark while keeping pi's
        // provider-facing session/cache key under 64 characters.
        if (threadedConversation && m.thread_id !== undefined && m.root_id === undefined) {
          log.warn(
            `${label} threaded ${m.chat_type} message ${m.message_id} has thread_id ${m.thread_id} but no root_id — session continuity cannot be guaranteed`,
          );
        }
        const defaultSession = threadedConversation
          ? `${kind}:${m.thread_id === undefined ? m.message_id : (m.root_id ?? `missing-root:${m.thread_id}`)}`
          : placeKey(m);
        const session = r.session ?? defaultSession;
        const chatId = r.chatId ?? m.chat_id;
        // Groups always quote the summon. Threaded groups and p2p add reply_in_thread: on a top-level
        // message that creates the thread, and on a continuation it keeps the answer inside it. Only
        // quote when the resolved target is the source chat — a custom redirect cannot reuse a message
        // id there. A continuous group still keeps replies inside an already-existing platform topic.
        const sameTarget = chatId === m.chat_id;
        const replyTo = sameTarget && (m.chat_type === "group" || threadedP2p) ? m.message_id : undefined;
        const replyInThread =
          replyTo !== undefined && (threadedConversation || m.thread_id !== undefined) ? true : undefined;
        // Queue feedback always identifies the exact ask, including continuous modes. In threaded mode
        // it inherits replyInThread, so an ask queued inside a root cannot leak a status card to main chat.
        const queueReplyTo = sameTarget ? m.message_id : undefined;
        const resources = normalized.content.resources;
        const images = resources
          .filter((resource) => resource.kind === "image")
          .map((resource) => ({ msg: resource.messageId, key: resource.key }));
        const files = resources
          .filter((resource) => resource.kind === "file" || resource.kind === "audio" || resource.kind === "video")
          .map((resource) => ({ msg: resource.messageId, key: resource.key, name: resource.name }));
        const baseText = r.text ?? cloudEnvelope(event, kind);
        if (baseText.trim() !== "" || images.length > 0 || files.length > 0) {
          submit(
            {
              id: m.message_id,
              seq: ++seqCounter,
              session,
              baseText,
              chatId,
              replyTo,
              queueReplyTo,
              replyInThread,
              // Inside a threaded session the root conversation history already contains the previous
              // turns. Reloading parent_id would duplicate that input (and its attachments). A top-level
              // quoted reply has no thread_id, starts a new root, and still hydrates its referent.
              parentId: threadedConversation && m.thread_id !== undefined ? undefined : m.parent_id,
              images,
              files,
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
    return { [`POST /${kind}`]: handler };
  };
}
