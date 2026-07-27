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
import { ensureStateHome, removeRetiredStateFile } from "../state.ts";
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
import { type FeishuApi, type FeishuTarget, createFeishuApi } from "./feishu-api.ts";
import type { FeishuEventHeader } from "./model.ts";
import { normalizeFeishuMessage } from "./normalize.ts";
import { createThreadParticipants } from "../thread-participants.ts";
import {
  FEISHU_GROUP_CONTEXT_SCOPE,
  FEISHU_MESSAGE_READ_REQUEST,
  FEISHU_MESSAGE_READ_SCOPE,
  scopeSatisfied,
} from "./setup-mode.ts";
import {
  type FeishuMessage,
  type FeishuMessageEvent,
  type FeishuRoute,
  cloudEnvelope,
  defaultFeishuRoute,
  feishuEnvelope,
  placeKey,
  senderId,
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
  /** Context-buffer bucket to fold at dequeue (main chat, or this message's thread root). */
  bufferKey: string;
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
    typeof r.bufferKey === "string" &&
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
  /** Routes + persists the event before the transport ACKs it; a throw must fail the delivery so the
   *  platform re-pushes. Synchronous — it touches no network. The Agent turn stays fire-and-forget. */
  acceptEvent(event: FeishuMessageEvent): void;
  turnsIdle(): Promise<void>;
}

/** The participant model removed the session modes (docs/design/participant-model.md §12). An upgraded
 *  workspace still passing one would otherwise start fine and silently get different placement AND a
 *  different memory boundary — the one breaking change most likely to be hit, and invisible. */
function rejectRemovedSessionOptions(opts: FeishuChannelBaseOptions, factoryName: string): void {
  const removed = ["directMessageSession", "groupMessageSession"].filter(
    (name) => (opts as unknown as Record<string, unknown>)[name] !== undefined,
  );
  if (removed.length > 0) {
    throw new Error(
      `${factoryName} no longer accepts ${removed.join(" / ")}: a chat is one session and a thread is another, ` +
        "and the summon rule no longer depends on the mode — remove the option (see docs/design/participant-model.md)",
    );
  }
}

function createFeishuRuntimeFactory(
  profile: FeishuCloudProfile,
  opts: FeishuChannelBaseOptions,
  factoryName: string,
): (ctx: ChannelContext) => FeishuRuntime {
  const { appId, appSecret, route, onError, queueNoticeDelayMs = QUEUE_NOTICE_DELAY_MS } = opts;
  const baseUrl = opts.apiBaseUrl ?? profile.apiBase;
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
    // Until it resolves (or if it fails), group summon stays off — fail-closed — while p2p works. A
    // mention landing in that first moment is buffered as context rather than answered; it is folded
    // into the next answered turn in that place, so the ask is delayed, never lost.
    let botOpenId: string | undefined;
    void api.botInfo().then(
      (me) => {
        botOpenId = me.openId;
        if (!botOpenId) log.warn(`${label} bot/v3/info returned no open_id — group @mention summon stays off`);
      },
      (e) => log.warn(`${label} bot/v3/info failed; group @mention summon stays off until restart: ${String(e)}`),
    );
    void api.listAppScopes().then(
      (scopes) => {
        const grantedScope = (name: string): boolean =>
          scopes.some(
            (scope) =>
              scope.name === name && scope.grantStatus === 1 && (scope.type === undefined || scope.type === "tenant"),
          );
        if (grantedScope(FEISHU_GROUP_CONTEXT_SCOPE)) {
          // This scope settles the rule's whole input: it delivers the un-mentioned group messages the
          // channel buffers, which is also what lets it HEAR a thread. Nothing is fetched, so nothing
          // is pending — the only bootstrap left is social, one mention inside a thread. The read scope
          // is a separate, softer dependency, so it is reported separately rather than folded in.
          log.info(
            `${label} group visibility: context-aware — buffered discussion enabled; bare replies work in a thread once the agent has been mentioned in it`,
          );
        } else {
          log.warn(
            `${label} group visibility: @mentions only — ${FEISHU_GROUP_CONTEXT_SCOPE} is not granted; bare replies in the agent's threads + group context buffering are unavailable`,
          );
        }
        // Reported OUTSIDE the branch above: the quoted-message read runs in every chat type and every
        // posture (a p2p thread's opening ask, any quoted @mention in a group), so pairing this warning
        // with the group scope would leave a mention-only deployment silently losing every referent.
        if (!scopeSatisfied(FEISHU_MESSAGE_READ_REQUEST, grantedScope)) {
          log.warn(
            `${label} ${FEISHU_MESSAGE_READ_SCOPE} is not granted — a message quoted by an ask cannot be read, and degrades to a marker in the prompt`,
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
    // The participant model replaced the owned-thread index (a cache, so nothing is lost). REMOVE THIS
    // after the release following the participant model ships — by then no live deployment can still
    // be carrying the file. test/migration-deadline.test.ts fails when due.
    removeRetiredStateFile(stateHome, "owned-threads.json", label);
    const threadParticipants = createThreadParticipants(join(stateHome, "thread-participants.json"), label);
    /** This channel's place key for a thread (the shared store is key-agnostic). */
    // The SAME identity the session uses (`placeKey`) — a thread's place. Defining it twice would let a
    // future re-keying silently split participation from the sessions it is supposed to describe.
    const threadKey = (chatId: string, threadId: string): string =>
      placeKey(kind, { chat_id: chatId, thread_id: threadId });
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
    for (const { attempts: _a, ...intent } of recovered) submit({ ...intent, preview: undefined }, false);

    // Who the agent has heard in a thread decides whether a bare message addresses it (participant
    // model §3), and it comes from what this channel observed — see thread-participants.ts.

    let warnedUnidentified = false;

    /**
     * What this delivery contributes to thread participation, or undefined when it contributes nothing.
     *
     * ONE gate for BOTH writes (the humans observation on the way in, and the `agentSpoke` merge once
     * the turn is durable), and one definition of the synthetic speaker id — hand-written conditions in
     * two places is the drift that has already bitten this branch once. Structural facts only; see
     * thread-participants.ts for why configuration must not appear here.
     *
     * Feishu-specific: p2p is excluded (nothing reads those records), and a custom route may admit a
     * bot the default route filters out — answering one is not participation the summon rule should
     * act on, so such a thread keeps no record and the first human still needs the mention bootstrap.
     */
    const heardIn = (
      m: FeishuMessage,
      sender: FeishuMessageEvent["sender"],
    ): { key: string; speaker: string } | undefined => {
      if (m.chat_type !== "group" || m.thread_id === undefined || sender?.sender_type !== "user") return undefined;
      const speakerId = senderId(sender);
      if (speakerId === undefined && !warnedUnidentified) {
        // Once per MOUNT — the flag lives in this channel's closure on purpose: the condition is a
        // property of THIS app's event configuration, so a `feishu` and a `lark` mount must each be
        // able to report it. A per-thread set would instead grow without bound to repeat one fact.
        warnedUnidentified = true;
        log.warn(
          `${label} human senders arrive with no usable id (first seen in thread ${m.thread_id}) — each counts as a distinct speaker, so affected threads permanently require an @mention until thread-participants.json is deleted`,
        );
      }
      // A human whose id no tenant flavour carries still SPOKE, and no human may speak unrecorded. A
      // per-MESSAGE synthetic id keeps them distinct; a per-thread one would collapse every human on an
      // id-less tenant into one, which is the direction that barges into a crowd. Its cost is PERMANENT
      // — two such messages fill MAX_HUMANS and records never shed, so that thread needs an @mention
      // from then on and only deleting the file resets it (§3).
      return { key: threadKey(m.chat_id, m.thread_id), speaker: speakerId ?? `unidentified:${m.message_id}` };
    };

    // Transport-neutral acceptance boundary: normalize, route, persist intent/context, enqueue. It
    // touches no network, so it stays synchronous inside the platform's ACK window and the delivery
    // dedup ring alone is enough — there is no await for a duplicate push to race through. The
    // minutes-long Agent turn remains fire-and-forget.
    const acceptEvent = (event: FeishuMessageEvent): void => {
      const m = event.message;
      if (!m?.message_id || !m.chat_id) return;
      if (seen.has(m.message_id)) {
        log.debug(`${label} duplicate push for message ${m.message_id} — already persisted, skipping`);
        return;
      }
      let r = decide(event);
      const normalized = normalizeFeishuMessage(event);
      if (!normalized) return;
      const bufferKey = feishuBufferPlaceKey(normalized.conversation);
      const isHumanGroup = event.sender?.sender_type === "user" && m.chat_type === "group";
      // Listening is not speaking: every message the channel can see refines who takes part in its
      // thread, whether or not it is answered. The sender counts toward the rule immediately — a
      // second human speaking is exactly what makes addressing ambiguous again.
      const heard = heardIn(m, event.sender);
      if (heard) threadParticipants.merge(heard.key, { humans: [heard.speaker] });

      if (
        !r &&
        route === undefined &&
        isHumanGroup &&
        m.thread_id !== undefined &&
        !normalized.content.hasMentions &&
        threadParticipants.admitsBareMessage(threadKey(m.chat_id, m.thread_id))
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
      const session = r.session ?? placeKey(kind, m);
      const chatId = r.chatId ?? m.chat_id;
      const sameTarget = chatId === m.chat_id;
      // Answer where asked (§4): quote in a group so the ask is identifiable among many speakers,
      // stay plain in an ordinary direct message, and stay inside a thread whenever the question came
      // from one — a direct message's thread is a place too, and relocating out of it is the silent
      // move the model refuses.
      const replyTo = sameTarget && (m.chat_type === "group" || m.thread_id !== undefined) ? m.message_id : undefined;
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

      submit(
        {
          id: m.message_id,
          seq: ++seqCounter, // arrival order; the turn store replays by it
          session,
          baseText,
          bufferKey,
          chatId,
          replyTo,
          queueReplyTo,
          replyInThread,
          // A quote is the user explicitly pointing at something that may predate this session
          // (§8 rung 2), so it is always loaded.
          //
          // There used to be an exception: skip it inside a thread the agent had already answered in,
          // since the session would hold it. That needed a second fact — did the channel RECEIVE the
          // messages in between? — which depends on a scope that changes over time, while the record it
          // was read against is durable. Every attempt to gate it correctly failed in the same
          // direction (a silently missing quote), for an optimisation worth one `getMessage` on a
          // quote-reply inside an active thread. Loading it costs a call and some text the session may
          // already have; it also pins WHICH message is being answered, which a long thread benefits
          // from anyway.
          parentId: m.parent_id,
          images,
          files,
        },
        true,
      );

      // Answering inside a thread makes the agent a participant of it, which is what lets the NEXT
      // bare message address it without a mention (§3).
      //
      // `r.session === undefined` is what makes this fact mean what its reader assumes. Participation
      // is keyed by THREAD while the memory it stands in for is keyed by SESSION, and those agree only
      // when the session is derived from the place. A route supplying its own (the scaffold's
      // `session: user:<open_id>` example) can put two people's turns in one thread into different
      // sessions — recording `agentSpoke` from one of them would tell the summon rule the agent took
      // part in a conversation it cannot remember. So the flag records "the agent answered into THIS
      // THREAD'S session". Such a thread keeps a bystander record and needs the ordinary mention to
      // bootstrap if the route is later dropped. `group` matches the observation above so the record is
      // never half-written.
      //
      // Recorded only once the intent is durable: `submit` can throw, and a redelivery must still see
      // the thread as the agent has actually left it. A later delivery failure does not undo it —
      // entering the conversation is the intent, not the send.
      // Reuses `heardIn` from the way in, so both writes share ONE gate by construction. The extra
      // conditions are about the ANSWER, not the speaker: it must land in this thread (`sameTarget`,
      // `replyInThread`) and in the place's own session, or the flag would claim a memory that never
      // held the turn.
      if (heard && replyInThread === true && sameTarget && r.session === undefined) {
        // Both halves in ONE merge, like Slack's: a record that needed an earlier merge to survive
        // could otherwise say "answered here, heard nobody" — which admits bare messages forever.
        threadParticipants.merge(heard.key, { agentSpoke: true, humans: [heard.speaker] });
      }
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
    runtime.acceptEvent((envelope.event ?? {}) as FeishuMessageEvent);
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
  rejectRemovedSessionOptions(opts, factoryName);
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
  rejectRemovedSessionOptions(opts, factoryName);
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
          domain: opts.apiBaseUrl ?? profile.apiBase,
          onEvent: runtime.acceptEvent,
        },
        signal,
      );
    },
  };
}
