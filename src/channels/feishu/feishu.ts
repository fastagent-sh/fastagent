/**
 * Canonical Feishu bot-channel engine: verified webhook or official-SDK WebSocket → dedup → route →
 * persist → enqueue → stream a live card. Feishu (open.feishu.cn) is the reference cloud. Lark
 * international binds this engine through an explicit compatibility profile because its control plane
 * trails Feishu; protocol reuse does not make Lark the design center.
 *
 * The channel kind remains the unit of route, env namespace, state home, logs, and onboarding, so one
 * workspace may run both without sharing state. Webhook returns the existing route factory; WebSocket
 * returns an explicit long-connection module. Both feed the same acceptance/turn engine. See docs/feishu.md.
 */
import { isAbsolute, join } from "node:path";
import type { ChannelContext, ChannelModule, LongConnectionChannelModule, Routes } from "../../host/node.ts";
import { log } from "../../log.ts";
import { readBodyCapped } from "../body.ts";
import { text } from "../respond.ts";
import { createSeenRing } from "../seen.ts";
import { createTaskTracker } from "../tasks.ts";
import { ensureStateHome } from "../state.ts";
import { dispatchStop, isStopText } from "../stop-command.ts";
import { createTurnQueue } from "../turn-queue.ts";
import { createTurnStore } from "../turn-store.ts";
import { FEISHU_CLOUD, type FeishuCloudProfile } from "./cloud.ts";
import {
  collectFeishuBufferedAttachments,
  createFeishuContextBuffer,
  feishuBufferPlaceKey,
  feishuBufferText,
} from "./context-buffer.ts";
import { decryptEvent, timingSafeEqualStr, verifySignature } from "./crypto.ts";
import { invokeFeishuTurn } from "./invoke-turn.ts";
import {
  type FeishuApi,
  type FeishuTarget,
  createFeishuApi,
  feishuApiErrorCode,
  isFeishuApiRejection,
} from "./feishu-api.ts";
import type { FeishuEventHeader } from "./model.ts";
import { normalizeFeishuMessage } from "./normalize.ts";
import { createFeishuThreadParticipants } from "./thread-participants.ts";
import { FEISHU_GROUP_CONTEXT_SCOPE } from "./setup-mode.ts";
import {
  type FeishuMessage,
  type FeishuMessageEvent,
  type FeishuRoute,
  cloudEnvelope,
  defaultFeishuRoute,
  feishuEnvelope,
  placeKey,
  senderLabel,
} from "./parse.ts";
import {
  type FeishuFailure,
  type MountedFeishuPreview,
  defaultErrorMessage,
  mountFeishuPreview,
  settleFeishuPreview,
  streamFeishuReply,
} from "./preview.ts";
import { connectFeishuWs } from "./ws-ingress.ts";

// Canonical public surface; the Lark subpath aliases these types/functions at its compatibility boundary.
export { defaultFeishuRoute, feishuEnvelope };
export type { FeishuFailure, FeishuMessage, FeishuMessageEvent, FeishuRoute };

/** Execution ceiling: a turn that has STARTED running this many times without finishing is dropped
 *  rather than run again (a poison turn must not loop forever under a restart policy). Counted per turn
 *  at dequeue, so a never-run turn queued behind a poison one keeps its full budget. */
const MAX_TURN_ATTEMPTS = 3;

/** Event body cap — events are small JSON; 1 MiB is generous and guards a public endpoint. */
const MAX_EVENT_BYTES = 1 << 20;

/** ONE shared budget for all pre-ACK platform waits of a delivery (bot identity + thread read): the
 *  platform expects event ACKs within seconds, so the total acceptance wait — not each await — is
 *  capped and must never ride the API pipeline's full 30s timeout + retry budget. On expiry the
 *  delivery is treated as transiently unreadable (re-pushed), not as unmanaged. */
const ACK_CHECK_BUDGET_MS = 2000;

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
  /** Context-buffer bucket to fold at dequeue (main chat, or this message's thread root). Optional only
   *  for recovery compatibility with turn records written before context buffering existed. */
  bufferKey?: string;
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
    (r.bufferKey === undefined || typeof r.bufferKey === "string") &&
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
interface PendingFeishuTurn extends Omit<StoredFeishuTurn, "attempts" | "bufferKey"> {
  bufferKey: string;
  /** The queue-status card/text, when its delayed mount fired. The turn's preview takes it over. */
  preview?: MountedFeishuPreview;
}

interface FeishuChannelBaseOptions {
  /** App ID (developer console → Credentials & Basic Info). */
  appId: string;
  /** App Secret (same page) — drives both ingress authentication and outbound API calls. */
  appSecret: string;
  /** Policy: whether/where to answer an event (return null to ignore). Defaults to {@link defaultFeishuRoute}. */
  route?: (event: FeishuMessageEvent) => FeishuRoute | null;
  /** Customer-facing failure text for the chat (the dev-facing full `details` always go to the operator
   *  log). Return a string to send it, or undefined/"" to stay silent. Default: a neutral message keyed
   *  on `retryable`. A developer's own bot can surface the raw details, e.g. `(f) => `⚠️ ${f.details}``. */
  onError?: (failed: FeishuFailure) => string | undefined;
  /** API origin override (tests / self-hosted gateways). Feishu factories default to
   *  `https://open.feishu.cn`; Lark factories default to `https://open.larksuite.com`. Named to match
   *  the other channels (telegram/slack). */
  apiBaseUrl?: string;
  /** @deprecated Alias of {@link apiBaseUrl}; kept for existing feishu/lark channel files. */
  baseUrl?: string;
  /** How long (ms) a turn waits before its reply-quoted "⏳ Queued" card mounts. Defaults to 0
   *  (immediate); the same card is later taken over by the live preview/final answer. */
  queueNoticeDelayMs?: number;
}

export interface FeishuChannelOptions extends FeishuChannelBaseOptions {
  /** Verification Token for Request-URL authentication. */
  verificationToken: string;
  /** Optional webhook Encrypt Key. When set, plaintext events are rejected. */
  encryptKey?: string;
}

export type FeishuWebSocketChannelOptions = FeishuChannelBaseOptions & {
  verificationToken?: never;
  encryptKey?: never;
};

/** Build the canonical Feishu Request-URL webhook channel. */
export function feishuChannel(opts: FeishuChannelOptions): ChannelModule {
  return buildFeishuChannel(FEISHU_CLOUD, opts, feishuChannel.name);
}

/** Build the canonical Feishu WebSocket long-connection channel. */
export function feishuWebSocketChannel(opts: FeishuWebSocketChannelOptions): LongConnectionChannelModule {
  return buildFeishuWebSocketChannel(FEISHU_CLOUD, opts, feishuWebSocketChannel.name);
}

/** Internal compatibility seams: protocol behavior comes from Feishu; the profile binds cloud edges. */
interface FeishuWebSocketChannelDeps {
  connectWs?: typeof connectFeishuWs;
}

interface FeishuRuntime {
  /** Settles once the event is routed + persisted (pre-ACK); a rejection must fail the delivery so
   *  the platform re-pushes. The Agent turn itself stays fire-and-forget. */
  acceptEvent(event: FeishuMessageEvent): Promise<void>;
  turnsIdle(): Promise<void>;
}

function createFeishuRuntimeFactory(
  profile: FeishuCloudProfile,
  opts: FeishuChannelBaseOptions,
  factoryName: string,
): (ctx: ChannelContext) => FeishuRuntime {
  const { appId, appSecret, route, onError, queueNoticeDelayMs = QUEUE_NOTICE_DELAY_MS } = opts;
  const baseUrl = opts.apiBaseUrl ?? opts.baseUrl ?? profile.apiBase;
  const { kind } = profile;
  const label = `[${kind}]`;
  return ({ agent, stateRoot, control }) => {
    // Credential checks run when serving starts, not while the authored module is imported: deployment
    // can inspect the module shape before secrets exist, while serving still fails before ready.
    if (!appId || !appSecret) {
      throw new Error(`${factoryName} requires appId + appSecret (developer console → Credentials & Basic Info)`);
    }
    const formatError = onError ?? defaultErrorMessage;
    const api: FeishuApi = createFeishuApi({ kind, baseUrl, appId, appSecret });

    // One bot/v3/info at startup: the bot's open_id drives the default route's group @mention summon.
    // Until it resolves (or if it fails), group summon stays off — fail-closed — while p2p works. The
    // acceptance path additionally awaits this promise (bounded) so a startup race delays a group
    // message instead of misclassifying it as "not addressed to me".
    let botOpenId: string | undefined;
    const botIdentity: Promise<void> = api.botInfo().then(
      (me) => {
        botOpenId = me.openId;
        if (!botOpenId) log.warn(`${label} bot/v3/info returned no open_id — group @mention summon stays off`);
      },
      (e) => log.warn(`${label} bot/v3/info failed; group @mention summon stays off until restart: ${String(e)}`),
    );
    void api.listAppScopes().then(
      (scopes) => {
        const contextAware = scopes.some(
          (scope) =>
            scope.name === FEISHU_GROUP_CONTEXT_SCOPE &&
            scope.grantStatus === 1 &&
            (scope.type === undefined || scope.type === "tenant"),
        );
        if (contextAware) {
          log.info(
            `${label} group visibility: context-aware — bare replies in the agent's threads + buffered discussion enabled`,
          );
        } else {
          log.warn(
            `${label} group visibility: @mentions only — ${FEISHU_GROUP_CONTEXT_SCOPE} is not granted; bare replies in the agent's threads + group context buffering are unavailable`,
          );
        }
      },
      (error) => log.warn(`${label} could not inspect group visibility: ${String(error)}`),
    );
    const decide = route ?? ((event: FeishuMessageEvent) => defaultFeishuRoute(event, { botOpenId }));

    // The channel-state convention: this channel's durable home is `<stateRoot>/channels/<kind>`
    // (engine state at the root, channel state under `channels/<kind>/`) — derived, not an option, so
    // the operator's ONE state knob (FASTAGENT_STATE_DIR) can never be silently bypassed by glue.
    if (!isAbsolute(stateRoot)) {
      throw new Error(`${factoryName} requires an absolute ctx.stateRoot, got "${stateRoot}"`);
    }
    const stateHome = join(stateRoot, "channels", kind);
    ensureStateHome(stateHome); // create + self-ignore — buffers/files may carry chat content
    const threadParticipants = createFeishuThreadParticipants(join(stateHome, "thread-participants.json"), label);
    const buffer = createFeishuContextBuffer(join(stateHome, "buffers.json"), label);
    const store = createTurnStore<StoredFeishuTurn>(join(stateHome, "turns.json"), {
      label,
      isRecord: isStoredFeishuTurn,
      order: (a, b) => a.seq - b.seq,
    });
    const seen = createSeenRing(join(stateHome, "seen.json"), label);
    // Side tasks (stop feedback) run off the ingress path but drain in turnsIdle.
    const sideTasks = createTaskTracker();
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
        // Snapshot background discussion at dequeue. Commit only this snapshot on `completed`, so a
        // message arriving while the turn runs remains buffered for the next answered turn.
        // ponytail: independent threaded roots in one main chat dequeue concurrently and may both fold
        // this snapshot before either commits it. That fan-out loses nothing; claiming by buffer key
        // would instead couple otherwise-independent root sessions and require failure rollback.
        const { text: recent, consumed } = buffer.peek(rec.bufferKey);
        const prompt = recent ? `[recent group discussion:\n${recent}\n]\n\n${rec.baseText}` : rec.baseText;
        const buffered = collectFeishuBufferedAttachments(consumed, {
          images: rec.images.map((ref) => ({ messageId: ref.msg, key: ref.key })),
          files: rec.files.map((ref) => ({ messageId: ref.msg, key: ref.key, name: ref.name })),
        });
        try {
          await streamFeishuReply(
            invokeFeishuTurn(
              agent,
              rec.session,
              prompt,
              { api, chatId: rec.chatId, filesDir: join(stateHome, "files"), label },
              { primary: { images: rec.images, files: rec.files, parentId: rec.parentId }, buffered },
              () => {
                // Drop intent first: a crash between these writes may re-fold answered context later,
                // but can never replay this turn after its context was removed.
                store.remove(rec.id);
                buffer.commit(rec.bufferKey, consumed);
              },
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

    // Accept a turn: persist its intent before the ACK, then record the platform delivery id and enqueue
    // it. The ordering is deliberate: recording first could turn a failed intent write into silent loss
    // when the platform redelivers. Recovery re-enqueues a crash survivor without re-persisting it.
    const submit = (rec: PendingFeishuTurn, persist: boolean): void => {
      if (persist) {
        store.add(toStored(rec)); // failed write → HTTP/WS 500 → platform re-push
        seen.add(rec.id); // post-persist, best-effort protection from documented duplicate pushes
      }
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
    for (const { attempts: _a, ...intent } of recovered) {
      // A pre-buffer-version record has no trustworthy place identity. Give it an empty private bucket
      // rather than risk consuming new main-chat context that arrived after this restart.
      const bufferKey = intent.bufferKey ?? `${intent.chatId}:legacy-turn:${intent.id}`;
      submit({ ...intent, bufferKey, preview: undefined }, false);
    }

    // Who takes part in a thread decides whether a bare message addresses the agent (participant
    // model §3). Participation is observed from every message the channel sees, and re-derived from
    // the platform for a thread this process has never seen — so a lost state disk costs one list
    // call, not the behavior.
    const threadReads = new Map<string, Promise<void>>();

    /**
     * Merge one observed human sender into its thread's participation. Only humans: the platform does
     * not push the agent's own messages back to it, and the event's sender id is an open_id while a
     * bot is identified by app id — agent participation is recorded where it is actually known (when
     * this channel answers in the thread, and from the platform listing).
     */
    const observeThreadSender = (
      m: FeishuMessage,
      senderType: string | undefined,
      senderId: string | undefined,
    ): void => {
      if (m.thread_id === undefined || senderType !== "user" || senderId === undefined) return;
      threadParticipants.merge(m.chat_id, m.thread_id, { humans: [senderId] });
    };

    /** Cap a pre-ACK wait at the delivery's shared `deadline` (epoch ms; see {@link ACK_CHECK_BUDGET_MS}).
     *  `work` may be abandoned by the race (its own late rejection is muted so it cannot become an
     *  unhandled rejection); `onTimeout` lets the caller cancel the abandoned work instead of leaving
     *  it to ride the API pipeline's full budget. */
    const withAckDeadline = async <T>(
      work: Promise<T>,
      what: string,
      deadline: number,
      onTimeout?: () => void,
    ): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      Promise.resolve(work).catch(() => {});
      // The budget is SHARED, so this wait's own share is whatever is left — report that, not the
      // constant, or an operator reads every timeout as a full-budget stall.
      const share = Math.max(0, deadline - Date.now());
      try {
        return await Promise.race([
          work,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              onTimeout?.();
              reject(new Error(`${what} exceeded its ${share}ms share of the ${ACK_CHECK_BUDGET_MS}ms pre-ACK budget`));
            }, share);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    // One operator-visible warning per rejection CLASS (platform code): a deleted thread (expected,
    // per-resource) and a missing message-read permission (app-wide — it disables every bare
    // continuation) must not share a budget, or the second hides behind the first. Repeats of a class
    // stay at debug.
    const warnedRejectionCodes = new Set<number>();

    /** Read a thread's senders back from the platform and merge them into the participation cache. */
    const readThreadParticipants = async (chatId: string, threadId: string, deadline: number): Promise<void> => {
      const abort = new AbortController();
      let senders: { senderType: string; senderId: string }[];
      try {
        senders = await withAckDeadline(
          // No rate-limit backoff: the pipeline's retries (up to 6s) cannot fit this budget, and under
          // rate limiting they would amplify each re-push into several more requests.
          api.listThreadSenders(threadId, { signal: abort.signal, noRateLimitRetry: true }),
          `thread participant read`,
          deadline,
          () => abort.abort(),
        );
      } catch (error) {
        if (!isFeishuApiRejection(error)) {
          // Transient (network/5xx/rate limit/timeout). This runs BEFORE we know whether the message
          // addresses the agent, so most deliveries hitting it are ordinary thread chatter that would
          // only have buffered — the trade-off is: unknown-addressing messages fail closed (HTTP 500 /
          // WS 500 frame → platform re-push → re-check), because ACKing here would silently downgrade
          // a GENUINE ask to background context. If every bounded re-push fails, both the turn and the
          // buffered copy are lost (operator log only) — accepted; see docs/design/participant-model.md.
          throw new Error(`${label} could not read thread ${threadId} pre-ACK: ${String(error)}`, { cause: error });
        }
        // A definitive platform rejection (deleted thread, missing read permission): participation is
        // not derivable. Record the thread as seen-but-empty so the read is not retried per message;
        // the agent then stays @-only there, and a permission grant plus restart recovers.
        const line = `${label} thread ${threadId} is not readable — staying mention-only there: ${String(error)}`;
        const code = feishuApiErrorCode(error) ?? 0;
        if (warnedRejectionCodes.has(code)) {
          log.debug(line);
        } else {
          warnedRejectionCodes.add(code);
          log.warn(`${line} (if this repeats for every thread, check the app's message-read permissions)`);
        }
        threadParticipants.merge(chatId, threadId, { derived: true });
        return;
      }
      threadParticipants.merge(chatId, threadId, {
        humans: senders.filter((s) => s.senderType === "user").map((s) => s.senderId),
        agentSpoke: senders.some((s) => s.senderType === "app" && s.senderId === appId),
        derived: true,
      });
    };

    /**
     * The participant model's summon rule for a bare message in a thread (§3): speak unprompted only
     * where the agent takes part AND exactly one human does. Both facts come from the participation
     * cache, which is refined by every observed message and re-derived from the platform once for a
     * thread this process has never seen.
     */
    const threadAddressesAgent = async (
      chatId: string,
      threadId: string,
      deadline: number,
      known: boolean,
    ): Promise<boolean> => {
      if (!known) {
        // One platform read per thread, shared by every delivery awaiting it (sharers resume in arrival
        // order; a joiner inherits the FIRST caller's deadline, still within one budget of that start).
        // LIVE order is best-effort across this window: a message that skips the check (an @mention, a
        // stop) reaches `queue.accept` first and runs first, even in the same session. Only durable
        // RECOVERY order is guaranteed — `seq` is assigned at arrival, before this await.
        const key = `${chatId}:${threadId}`;
        let read = threadReads.get(key);
        if (read === undefined) {
          read = readThreadParticipants(chatId, threadId, deadline).finally(() => threadReads.delete(key));
          threadReads.set(key, read);
        }
        await read;
      }
      const participation = threadParticipants.get(chatId, threadId);
      if (participation === undefined) return false;
      return participation.agentSpoke && participation.humans.length === 1;
    };

    // Concurrent duplicate deliveries of one message (documented platform behavior) share ONE outcome:
    // both ACK success, or both leave the delivery re-pushable — never one 200 racing one 500.
    const inflight = new Map<string, Promise<void>>();

    // Transport-neutral acceptance boundary. It performs only bounded pre-ACK work: normalize, route
    // (including the deadline-capped thread-participant read above on a cache miss), persist
    // intent/context, and enqueue. The minutes-long Agent turn remains fire-and-forget.
    const acceptEvent = (event: FeishuMessageEvent): Promise<void> => {
      const m = event.message;
      if (!m?.message_id || !m.chat_id) return Promise.resolve();
      if (seen.has(m.message_id)) {
        log.debug(`${label} duplicate push for message ${m.message_id} — already persisted, skipping`);
        return Promise.resolve();
      }
      let pending = inflight.get(m.message_id);
      if (pending === undefined) {
        pending = acceptNewEvent(event).finally(() => inflight.delete(m.message_id));
        inflight.set(m.message_id, pending);
      } else {
        log.debug(`${label} duplicate push for message ${m.message_id} — joining the in-flight acceptance`);
      }
      return pending;
    };

    const acceptNewEvent = async (event: FeishuMessageEvent): Promise<void> => {
      const m = event.message;
      if (!m?.message_id || !m.chat_id) return;
      const deadline = Date.now() + ACK_CHECK_BUDGET_MS;
      // A group summon is matched against the bot's own open_id, so a message arriving before
      // bot/v3/info settles would be misread as "not addressed to me" and downgraded to context. Wait
      // for the identity within the shared pre-ACK budget (already settled after startup, so free).
      if (botOpenId === undefined && m.chat_type === "group") {
        await withAckDeadline(botIdentity, `${label} bot identity resolution`, deadline);
      }
      let r = decide(event);
      const normalized = normalizeFeishuMessage(event);
      if (!normalized) return;
      const seq = ++seqCounter; // arrival order, taken BEFORE any await below can reorder acceptance
      const bufferKey = feishuBufferPlaceKey(normalized.conversation);
      const isHumanGroup = event.sender?.sender_type === "user" && m.chat_type === "group";
      // Whether the thread was known BEFORE this message is what decides if participation has to be
      // read back from the platform — sample it first, because observing below would mask it.
      const threadKnown = m.thread_id !== undefined && threadParticipants.get(m.chat_id, m.thread_id)?.derived === true;
      // Listening is not speaking: every message the channel can see refines who takes part in its
      // thread, whether or not it is answered. The sender counts toward the rule immediately — a
      // second human speaking is exactly what makes addressing ambiguous again.
      observeThreadSender(m, event.sender?.sender_type, event.sender?.sender_id?.open_id);

      if (
        !r &&
        route === undefined &&
        isHumanGroup &&
        m.thread_id !== undefined &&
        !normalized.content.hasMentions &&
        (await threadAddressesAgent(m.chat_id, m.thread_id, deadline, threadKnown))
      ) {
        r = {};
      }
      if (!r) {
        if (route === undefined && isHumanGroup) {
          const bodyText = feishuBufferText(normalized.content.text);
          if (bodyText) {
            const resources = normalized.content.resources;
            const images = resources
              .filter((resource) => resource.kind === "image")
              .map((resource) => ({ messageId: resource.messageId, key: resource.key }));
            const files = resources
              .filter((resource) => resource.kind === "file" || resource.kind === "audio" || resource.kind === "video")
              .map((resource) => ({
                messageId: resource.messageId,
                key: resource.key,
                name: resource.name,
              }));
            // A write failure escapes this boundary. HTTP turns it into a 500 response; the official WS
            // SDK turns it into a 500 ACK frame. Both transports therefore ask the platform to re-push.
            buffer.push(bufferKey, {
              sender: senderLabel(event.sender) ?? "someone",
              body: bodyText,
              messageId: m.message_id,
              replyTo: m.parent_id,
              files: files.length ? files : undefined,
              images: images.length ? images : undefined,
            });
            seen.add(m.message_id);
            log.debug(`${label} buffered unsummoned group message ${m.message_id} (place ${bufferKey})`);
          } else {
            log.debug(`${label} not summoned — ignoring empty message ${m.message_id} (chat ${m.chat_id})`);
          }
        } else {
          log.debug(`${label} not summoned — ignoring message ${m.message_id} (chat ${m.chat_id}, ${m.chat_type})`);
        }
        return;
      }

      // Memory follows the place (participant model §5): one session per chat, and one per thread.
      // Keyed by `thread_id`, never `root_id` — the platform's root_id tracks the reply chain and can
      // differ between messages of ONE thread, which would split a side conversation in two.
      const session = r.session ?? placeKey(m);
      const chatId = r.chatId ?? m.chat_id;
      const sameTarget = chatId === m.chat_id;
      // Answer where asked (§4): quote in a group so the ask is identifiable, stay plain in a direct
      // message, and stay inside a thread when the question came from one.
      const replyTo = sameTarget && m.chat_type === "group" ? m.message_id : undefined;
      const replyInThread = replyTo !== undefined && m.thread_id !== undefined ? true : undefined;
      const queueReplyTo = sameTarget ? m.message_id : undefined;
      // Explicit user stop: a control action, never a turn — it must not queue behind the run it
      // stops. Mentions arrive as @name tokens; strip them before matching the bare word. Record the
      // message id so a platform re-push doesn't double-abort or double-notify.
      if (isStopText(normalized.content.text.replace(/@\S+/g, " "))) {
        seen.add(m.message_id);
        sideTasks.track(
          dispatchStop(control, session, label)
            .then((feedback) => api.sendText({ chatId, replyTo, replyInThread }, feedback).then(() => undefined))
            .catch((error) => log.warn(`${label} stop feedback failed: ${String(error)}`)),
        );
        return;
      }
      const resources = normalized.content.resources;
      const images = resources
        .filter((resource) => resource.kind === "image")
        .map((resource) => ({ msg: resource.messageId, key: resource.key }));
      const files = resources
        .filter((resource) => resource.kind === "file" || resource.kind === "audio" || resource.kind === "video")
        .map((resource) => ({ msg: resource.messageId, key: resource.key, name: resource.name }));
      const baseText = r.text ?? cloudEnvelope(event, kind);
      if (baseText.trim() === "" && images.length === 0 && files.length === 0) return;

      // Answering inside a thread makes the agent a participant of it, which is what lets the NEXT
      // bare message address it without a mention (§3). Recorded at acceptance, before the reply is
      // attempted: entering the conversation is the intent, and a delivery failure does not undo it.
      if (replyInThread === true && m.thread_id !== undefined && sameTarget) {
        threadParticipants.merge(m.chat_id, m.thread_id, { agentSpoke: true });
      }

      submit(
        {
          id: m.message_id,
          seq,
          session,
          baseText,
          bufferKey,
          chatId,
          replyTo,
          queueReplyTo,
          replyInThread,
          // The referent anchor is what a thread starts from (§8 rung 2): the first message of a
          // thread points at something OUTSIDE it — usually the agent's own previous answer — so it is
          // fetched. Later messages in a known thread point at the previous message, which the
          // session already holds; re-fetching it would cost a call per turn and duplicate context.
          parentId: threadKnown ? undefined : m.parent_id,
          images,
          files,
        },
        true,
      );
    };

    return { acceptEvent, turnsIdle: () => Promise.all([queue.idle(), sideTasks.drain()]).then(() => undefined) };
  };
}

function createFeishuWebhookRoutes(
  profile: FeishuCloudProfile,
  opts: FeishuChannelOptions,
  runtime: FeishuRuntime,
): Routes {
  const { verificationToken, encryptKey } = opts;
  const { kind, envPrefix } = profile;
  const label = `[${kind}]`;
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
        log.warn(`${label} rejected a plaintext event while encryptKey is set (console mismatch, or a forgery)`);
        return text("plaintext events not accepted\n", 401);
      }
      envelope = outer;
    }
    const token =
      (typeof envelope.token === "string" ? envelope.token : undefined) ??
      (typeof (envelope.header as Record<string, unknown> | undefined)?.token === "string"
        ? ((envelope.header as Record<string, unknown>).token as string)
        : undefined);
    if (!token || !timingSafeEqualStr(token, verificationToken)) {
      log.warn(
        `${label} rejected an event: verification token mismatch (check ${envPrefix}_VERIFICATION_TOKEN against the console)`,
      );
      return text("invalid token\n", 401);
    }

    if (envelope.type === "url_verification" && typeof envelope.challenge === "string") {
      log.info(`${label} answered the console's url_verification challenge`);
      return Response.json({ challenge: envelope.challenge });
    }
    const header = envelope.header as FeishuEventHeader | undefined;
    if (header?.event_type !== "im.message.receive_v1") {
      log.debug(`${label} ignoring event type ${header?.event_type ?? "(none)"}`);
      return new Response(null, { status: 200 });
    }
    await runtime.acceptEvent((envelope.event ?? {}) as FeishuMessageEvent);
    return new Response(null, { status: 200 });
  };
  (handler as typeof handler & { turnsIdle?: () => Promise<void> }).turnsIdle = runtime.turnsIdle;
  return { [`POST /${kind}`]: handler };
}

export function buildFeishuChannel(
  profile: FeishuCloudProfile,
  opts: FeishuChannelOptions,
  factoryName: string,
): ChannelModule {
  const createRuntime = createFeishuRuntimeFactory(profile, opts, factoryName);
  return (ctx) => {
    if (!opts.verificationToken) {
      throw new Error(`${factoryName} requires a non-empty verificationToken (console → Events & Callbacks)`);
    }
    return createFeishuWebhookRoutes(profile, opts, createRuntime(ctx));
  };
}

export function buildFeishuWebSocketChannel(
  profile: FeishuCloudProfile,
  opts: FeishuWebSocketChannelOptions,
  factoryName: string,
  deps: FeishuWebSocketChannelDeps = {},
): LongConnectionChannelModule {
  const createRuntime = createFeishuRuntimeFactory(profile, opts, factoryName);
  return {
    name: `${profile.kind} websocket`,
    connect(ctx, signal) {
      const runtime = createRuntime(ctx);
      return (deps.connectWs ?? connectFeishuWs)(
        {
          kind: profile.kind,
          appId: opts.appId,
          appSecret: opts.appSecret,
          domain: opts.apiBaseUrl ?? opts.baseUrl ?? profile.apiBase,
          onEvent: runtime.acceptEvent,
        },
        signal,
      );
    },
  };
}
