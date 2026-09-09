/**
 * Canonical Feishu bot-channel engine: verified webhook or official-SDK WebSocket → dedup → route → persist → enqueue
 * → stream a live card.
 */
import { isAbsolute, join } from "node:path";
import type { ChannelContext, ChannelModule, LongConnectionChannelModule, Routes } from "../../channel.ts";
import { log } from "../../log.ts";
import { readBodyCapped } from "../body.ts";
import { text } from "../respond.ts";
import { secretEquals } from "../secret.ts";
import { createSeenRing } from "../kit/seen.ts";
import { createTaskTracker } from "../kit/tasks.ts";
import { ensureStateHome, loadStateFile, saveStateFile } from "../kit/state.ts";
import { signatureIsFresh } from "../kit/signature.ts";
import { dispatchStop, isStopText } from "../kit/stop-command.ts";
import { createTurnRunner } from "../kit/turn-runner.ts";
import { createTurnStore } from "../kit/turn-store.ts";
import { discussionBlock } from "../kit/context-buffer.ts";
import { FEISHU_CLOUD, type FeishuCloudProfile } from "./cloud.ts";
import {
  type FeishuBufferEntry,
  collectFeishuBufferedAttachments,
  createFeishuContextBuffer,
  feishuBufferPlaceKey,
  feishuBufferText,
} from "./context-buffer.ts";
import { decryptEvent, verifySignature } from "./crypto.ts";
import { feishuTurnStream } from "./invoke-turn.ts";
import { type FeishuApi, type FeishuTarget, createFeishuApi } from "./feishu-api.ts";
import type { FeishuEventHeader } from "./model.ts";
import { normalizeFeishuMessage } from "./normalize.ts";
import { createThreadParticipants } from "../kit/thread-participants.ts";
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
  feishuReply,
} from "./preview.ts";
import { connectFeishuWs } from "./ws-ingress.ts";
import { registerFeishuApi } from "./shared-api.ts";

// Canonical public surface; the Lark subpath aliases these types/functions at its compatibility boundary.
export { defaultFeishuRoute, feishuEnvelope };
export type { FeishuFailure, FeishuMessage, FeishuMessageEvent, FeishuRoute };

/** Event body cap — events are small JSON; 1 MiB is generous and guards a public endpoint. */
const MAX_EVENT_BYTES = 1 << 20;

/**
 * Replay window for a SIGNED event, sized by the OPEN PLATFORM'S REDELIVERY SCHEDULE, not by Slack's 5 minutes: a
 * failed push is retried at 15s / 5min / 1h / 6h.
 */
const MAX_SIGNATURE_AGE_S = 7 * 60 * 60;

/**
 * Queue feedback is immediate by default: it is the user's acknowledgement that this exact ask was accepted behind
 * another turn.
 */
const QUEUE_NOTICE_DELAY_MS = 0;

const QUEUED_PLACEHOLDER = "⏳ Queued — I’ll start once the current task finishes.";
const DEFERRED_PLACEHOLDER = "⏳ Delayed by a temporary system issue — I’ll retry automatically.";

/** The persisted turn intent (what the runner needs to re-execute it). */
interface StoredFeishuTurn {
  id: string; // message_id (the platform delivery identity; seq below carries arrival order)
  seq: number;
  session: string;
  baseText: string;
  /** Context-buffer bucket to fold at dequeue (main chat, or this message's thread root). */
  bufferKey: string;
  chatId: string;
  replyTo?: string;
  /** Source message to quote when queue feedback mounts. */
  queueReplyTo?: string;
  replyInThread?: boolean;
  parentId?: string;
  /** The place this thread branched from (§5 lineage). */
  parentSession?: string;
  /** The ROOM's bucket to fold read-only into this turn (§8). */
  roomBufferKey?: string;
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
    (r.parentSession === undefined || typeof r.parentSession === "string") &&
    (r.roomBufferKey === undefined || typeof r.roomBufferKey === "string") &&
    refs(r.images) &&
    refs(r.files) &&
    typeof r.attempts === "number"
  );
}

/** One accepted turn: the persisted intent plus live-only fields. */
interface PendingFeishuTurn extends Omit<StoredFeishuTurn, "attempts"> {
  /** The queue-status card/text, when its delayed mount fired. */
  preview?: MountedFeishuPreview;
}

interface FeishuChannelBaseOptions {
  /** App ID (developer console → Credentials & Basic Info). */
  appId: string;
  /** App Secret (same page) — drives both ingress authentication and outbound API calls. */
  appSecret: string;
  /** Policy: whether/where to answer an event (return null to ignore). */
  route?: (event: FeishuMessageEvent) => FeishuRoute | null;
  /** Customer-facing failure text for the chat (the dev-facing full `details` always go to the operator log). */
  onError?: (failed: FeishuFailure) => string | undefined;
  /** API origin override (tests / self-hosted gateways). */
  apiBaseUrl?: string;
  /** How long (ms) a turn waits before its reply-quoted "⏳ Queued" card mounts. */
  queueNoticeDelayMs?: number;
}

export interface FeishuChannelOptions extends FeishuChannelBaseOptions {
  /** Verification Token for Request-URL authentication. */
  verificationToken: string;
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
  /**
   * Routes + persists the event before the transport ACKs it; a throw must fail the delivery so the platform
   * re-pushes.
   */
  acceptEvent(event: FeishuMessageEvent): void;
  turnsIdle(): Promise<void>;
}

/**
 * The bot's own open_id — the identity the default route matches group @mentions against. Seeded synchronously from
 * a per-app cache file so a cold start can summon before the network answers, then refreshed once per process by
 * `bot/v3/info`. The two failure directions differ: a FAILED call is transport weather and keeps the cached identity,
 * while a SUCCESSFUL call reporting no open_id is an affirmative "there is no bot here" and clears it (fail-closed).
 */
function createBotIdentity(deps: {
  api: FeishuApi;
  appId: string;
  label: string;
  botFile: string;
}): () => string | undefined {
  const { api, appId, label, botFile } = deps;
  const stored = loadStateFile(botFile) as { appId?: unknown; openId?: unknown } | undefined;
  if (stored !== undefined && typeof stored.appId !== "string") {
    log.warn(`${label} unexpected shape in ${botFile} — ignoring the cached bot identity`);
  }
  let cached = stored?.appId === appId && typeof stored.openId === "string" ? (stored.openId as string) : undefined;
  let current = cached;
  // `{ appId }` with no openId reads as "no cache" at the loader — the atomic write is reused instead of
  // introducing a deletion path.
  const persist = (openId: string | undefined, failure: string): void => {
    if (openId === cached) return;
    cached = openId;
    try {
      saveStateFile(botFile, openId === undefined ? { appId } : { appId, openId });
    } catch (e) {
      log.warn(`${label} ${failure}: ${String(e)}`);
    }
  };
  void api.botInfo().then(
    (me) => {
      if (me.openId) {
        if (current !== undefined && current !== me.openId) {
          log.info(`${label} bot open_id changed (${current} → ${me.openId}) — updating the cached identity`);
        }
        current = me.openId;
        persist(
          me.openId,
          `could not persist the bot identity to ${botFile} — the next cold start races bot/v3/info again`,
        );
        return;
      }
      log.warn(
        current === undefined
          ? `${label} bot/v3/info returned no open_id — group @mention summon stays off`
          : `${label} bot/v3/info returned no open_id — cached identity cleared; group @mention summon stays off`,
      );
      current = undefined;
      persist(undefined, `could not clear the cached bot identity ${botFile}`);
    },
    (e) =>
      log.warn(
        current === undefined
          ? `${label} bot/v3/info failed; group @mention summon stays off until restart: ${String(e)}`
          : `${label} bot/v3/info failed; running on the cached identity (bot.json): ${String(e)}`,
      ),
  );
  return () => current;
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
    // Credential checks run when serving starts, not while the authored module is imported.
    if (!appId || !appSecret) {
      throw new Error(`${factoryName} requires appId + appSecret (developer console → Credentials & Basic Info)`);
    }
    const formatError = onError ?? defaultErrorMessage;
    const api: FeishuApi = createFeishuApi({ kind, baseUrl, appId, appSecret });

    void api.listAppScopes().then(
      (scopes) => {
        const grantedScope = (name: string): boolean =>
          scopes.some(
            (scope) =>
              scope.name === name && scope.grantStatus === 1 && (scope.type === undefined || scope.type === "tenant"),
          );
        if (grantedScope(FEISHU_GROUP_CONTEXT_SCOPE)) {
          // This scope settles the rule's whole input: it delivers the un-mentioned group messages the channel
          // buffers, which is also what lets it HEAR a thread.
          log.info(
            `${label} group visibility: context-aware — buffered discussion enabled; bare replies work in a thread once the agent has been mentioned in it`,
          );
        } else {
          log.warn(
            `${label} group visibility: @mentions only — ${FEISHU_GROUP_CONTEXT_SCOPE} is not granted; bare replies in the agent's threads + group context buffering are unavailable`,
          );
        }
        // Reported OUTSIDE the branch above: the quoted-message read runs in every chat type and every posture (a p2p
        // thread's opening ask, any quoted @mention in a group), so pairing this warning with the group scope would
        // leave a mention-only deployment silently losing every referent.
        if (!scopeSatisfied(FEISHU_MESSAGE_READ_REQUEST, grantedScope)) {
          log.warn(
            `${label} ${FEISHU_MESSAGE_READ_SCOPE} is not granted — a message quoted by an ask cannot be read, and degrades to a marker in the prompt`,
          );
        }
      },
      (error) => log.warn(`${label} could not inspect group visibility: ${String(error)}`),
    );
    // The channel-state convention: this channel's durable home is `<stateRoot>/channels/<kind>` (engine state at the
    // root, channel state under `channels/<kind>/`).
    if (!isAbsolute(stateRoot)) {
      throw new Error(`${factoryName} requires an absolute ctx.stateRoot, got "${stateRoot}"`);
    }
    const stateHome = join(stateRoot, "channels", kind);
    ensureStateHome(stateHome); // buffers/files may carry chat content; the agent .gitignore covers .state/
    const botOpenId = createBotIdentity({ api, appId, label, botFile: join(stateHome, "bot.json") });
    const decide = route ?? ((event: FeishuMessageEvent) => defaultFeishuRoute(event, { botOpenId: botOpenId() }));
    const threadParticipants = createThreadParticipants(join(stateHome, "thread-participants.json"), label);
    /** This channel's place key for a thread (the shared store is key-agnostic). */
    // The SAME identity the session uses (`placeKey`) — a thread's place.
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
    const sideTasks = createTaskTracker(label);
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

    // Tell the asker when a turn is dropped at the execution ceiling: the chain's end needs a signal, not just an
    // operator log line.
    const notifyDropped = (r: PendingFeishuTurn): void => {
      const body = "⚠️ I couldn’t complete an earlier request — please ask again.";
      void settleFeishuPreview(api, targetOf(r), r.preview, body).catch((e) =>
        log.warn(`${label} could not notify a dropped turn (session=${r.session}): ${String(e)}`),
      );
    };

    const runner = createTurnRunner<PendingFeishuTurn, StoredFeishuTurn, FeishuBufferEntry>({
      label,
      store,
      buffer,
      seen,
      toStored: ({ preview: _live, ...intent }) => ({ ...intent, attempts: 0 }),
      fromStored: ({ attempts: _a, ...intent }) => ({ ...intent, preview: undefined }),
      bufferKey: (rec) => rec.bufferKey,
      where: (rec) => `chat=${rec.chatId}`,
      // Queue feedback: mount that turn's preview early with a queue status.
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
        return {
          done,
          // A no-op once mounting started — the send is in flight and `done` settles with it.
          cancel: () => {
            if (!fired) {
              if (timer !== undefined) clearTimeout(timer);
              settle();
            }
          },
        };
      },
      // Do not recall an existing queue preview (the client exposes a confusing tombstone): settle it in place to an
      // honest delayed status.
      onDeferred: (rec) => {
        if (rec.preview !== undefined) {
          void settleFeishuPreview(api, targetOf(rec), rec.preview, DEFERRED_PLACEHOLDER).catch((e) =>
            log.warn(`${label} could not update a deferred turn's queue preview: ${String(e)}`),
          );
        }
      },
      notifyDropped,
      execute: (rec, discussion, onCompleted) => {
        // PEEK and never commit: the room still owes this discussion to its OWN memory (§8). ponytail.
        const room = rec.roomBufferKey !== undefined ? buffer.peek(rec.roomBufferKey) : undefined;
        const roomBlock = room?.text
          ? `[recent discussion in the room this thread branched from — not yet answered there:\n${room.text}\n]\n\n`
          : "";
        const prompt = `${roomBlock}${discussionBlock(discussion.text)}${rec.baseText}`;
        // Room entries FIRST: the collector keeps the TAIL under its cap, so the thread's own attachments win the
        // slots.
        const buffered = collectFeishuBufferedAttachments([...(room?.consumed ?? []), ...discussion.consumed], {
          images: rec.images.map((ref) => ({ messageId: ref.msg, key: ref.key })),
          files: rec.files.map((ref) => ({ messageId: ref.msg, key: ref.key, name: ref.name })),
        });
        // Recorded at ingress (see submit) — never re-derived from the session key, which may be a routed OPAQUE id
        // that only looks like a place key.
        const parentSession = rec.parentSession;
        return feishuReply(
          feishuTurnStream(
            agent,
            rec.session,
            prompt,
            {
              api,
              chatId: rec.chatId,
              filesDir: join(stateHome, "files"),
              label,
              appId,
              ...(parentSession !== undefined ? { parentSession } : {}),
            },
            { primary: { images: rec.images, files: rec.files, parentId: rec.parentId }, buffered },
            onCompleted,
          ),
          api,
          targetOf(rec),
          formatError,
          rec.preview,
          label,
        );
      },
    });
    registerFeishuApi(stateRoot, kind, api);
    let seqCounter = runner.recover().reduce((max, r) => Math.max(max, r.seq), 0);

    // Who the agent has heard in a thread decides whether a bare message addresses it (participant model §3), and it
    // comes from what this channel observed.

    let warnedUnidentified = false;

    /** What this delivery contributes to thread participation, or undefined when it contributes nothing. */
    const heardIn = (
      m: FeishuMessage,
      sender: FeishuMessageEvent["sender"],
    ): { key: string; speaker: string } | undefined => {
      if (m.chat_type !== "group" || m.thread_id === undefined || sender?.sender_type !== "user") return undefined;
      const speakerId = senderId(sender);
      if (speakerId === undefined && !warnedUnidentified) {
        // Once per MOUNT — the flag lives in this channel's closure on purpose.
        warnedUnidentified = true;
        log.warn(
          `${label} human senders arrive with no usable id (first seen in thread ${m.thread_id}) — each counts as a distinct speaker, so affected threads permanently require an @mention until thread-participants.json is deleted`,
        );
      }
      // A human whose id no tenant flavour carries still SPOKE, and no human may speak unrecorded.
      return { key: threadKey(m.chat_id, m.thread_id), speaker: speakerId ?? `unidentified:${m.message_id}` };
    };

    // Transport-neutral acceptance boundary: normalize, route, persist intent/context, enqueue.
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
      // Listening is not speaking: every message the channel can see refines who takes part in its thread, whether or
      // not it is answered.
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
            // A write failure escapes this boundary.
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
      const routed = r.session;
      const session = routed ?? placeKey(kind, m);
      // Lineage is recorded ONLY for the default place-derived session.
      const parentSession =
        routed === undefined && m.thread_id !== undefined ? placeKey(kind, { chat_id: m.chat_id }) : undefined;
      // Read BEFORE this turn records its own participation below, or it is always true.
      const roomBufferKey =
        parentSession !== undefined && !threadParticipants.agentSpokeIn(session)
          ? feishuBufferPlaceKey({ chatId: m.chat_id })
          : undefined;
      const chatId = r.chatId ?? m.chat_id;
      const sameTarget = chatId === m.chat_id;
      // Answer where asked (§4): quote in a group so the ask is identifiable among many speakers, stay plain in an
      // ordinary direct message, and stay inside a thread whenever the question came from one — a direct message's
      // thread is a place too, and relocating out of it is the silent move the model refuses.
      const replyTo = sameTarget && (m.chat_type === "group" || m.thread_id !== undefined) ? m.message_id : undefined;
      const replyInThread = replyTo !== undefined && m.thread_id !== undefined ? true : undefined;
      const queueReplyTo = sameTarget ? m.message_id : undefined;
      // Explicit user stop: a control action, never a turn — it must not queue behind the run it stops.
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

      runner.submit(
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
          // A quote is the user explicitly pointing at something that may predate this session (§8 rung 2), so it is
          // always loaded.
          parentId: m.parent_id,
          ...(parentSession !== undefined ? { parentSession } : {}),
          ...(roomBufferKey !== undefined ? { roomBufferKey } : {}),
          images,
          files,
        },
        true,
      );

      // Answering inside a thread makes the agent a participant of it, which is what lets the NEXT bare message
      // address it without a mention (§3).
      if (heard && replyInThread === true && sameTarget && r.session === undefined) {
        // Both halves in ONE merge, like Slack's: a record that needed an earlier merge to survive could otherwise
        // say "answered here, heard nobody".
        threadParticipants.merge(heard.key, { agentSpoke: true, humans: [heard.speaker] });
      }
    };

    return { acceptEvent, turnsIdle: () => Promise.all([runner.idle(), sideTasks.drain()]).then(() => undefined) };
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
  if (!encryptKey) {
    // Said once at wiring, not per request: without an encrypt key events arrive in plaintext and carry no signature,
    // so the freshness window below never runs and a captured body replays for as long as the verification token
    // lives.
    log.warn(
      `${label} no ${envPrefix}_ENCRYPT_KEY: events are accepted unsigned, with no replay window — set one in the console to enable it`,
    );
  }
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
      if (sig.signature) {
        // Freshness BEFORE the signature: the signature covers the timestamp but proves nothing about it, so without
        // a window a captured body + its three x-lark-* headers replays forever.
        if (!signatureIsFresh(sig.timestamp, MAX_SIGNATURE_AGE_S)) {
          log.warn(
            `${label} rejected an event: X-Lark-Request-Timestamp outside the ±${MAX_SIGNATURE_AGE_S / 3600} h replay window`,
          );
          return text("stale signature\n", 401);
        }
        if (!verifySignature(encryptKey, sig, body.text)) {
          log.warn(`${label} rejected an event: invalid X-Lark-Signature (encrypt key mismatch, or a forgery)`);
          return text("invalid signature\n", 401);
        }
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
    if (!secretEquals(token, verificationToken)) {
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
          domain: opts.apiBaseUrl ?? profile.apiBase,
          onEvent: runtime.acceptEvent,
        },
        signal,
      );
    },
  };
}
