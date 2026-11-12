/**
 * Canonical Feishu bot-channel engine: verified webhook or official-SDK WebSocket → dedup → route → persist → enqueue
 * → stream a live card.
 */
import { recordReached } from "../webhook-evidence.ts";
import { join } from "node:path";
import { Effect } from "effect";
import type { ChannelContext, ChannelModule, LongConnectionChannelModule, Routes } from "../../channel.ts";
import { log } from "../../log.ts";
import { readBodyCapped } from "../body.ts";
import { text } from "../respond.ts";
import { secretEquals } from "../secret.ts";
import { createSeenRing } from "../kit/seen.ts";
import { createTaskTracker } from "../kit/tasks.ts";
import { attachmentsDir } from "../kit/attachment-path.ts";
import { loadStateFile, saveStateFile } from "../../state-file.ts";
import { signatureIsFresh } from "../kit/signature.ts";
import { dispatchStop, isStopText } from "../kit/stop-command.ts";
import { createRoomThreads, registerRoomThreads } from "../kit/room-threads.ts";
import type { ForkSource } from "../../channel.ts";
import { threadForkSource } from "../kit/thread-fork.ts";
import { createAskLog, readStart } from "../kit/ask-log.ts";
import { foldBudget } from "../kit/fold-budget.ts";
import { createMessageOwners } from "../kit/message-owners.ts";
import { senderConversation } from "../kit/sender-conversation.ts";
import type { PlaceMessage } from "../kit/place-history.ts";
import { createTurnRunner } from "../kit/turn-runner.ts";
import { SHARED_ANSWER_NOTICE } from "../kit/turn-gate.ts";
import { acknowledgeFeishuAsk } from "./reaction.ts";
import { portJoin } from "../../effect-port.ts";
import { type TurnRecordBase, createTurnStore } from "../kit/turn-store.ts";
import { discussionBlock } from "../kit/context-buffer.ts";
import { FEISHU_CLOUD, type FeishuCloudProfile } from "./cloud.ts";
import {
  type FeishuPosition,
  collectFoldedAttachments,
  compareFeishuPositions,
  createFeishuPlaceHistory,
  feishuHistoryKey,
  feishuPlaceOf,
  isFeishuPosition,
} from "./history.ts";
import { decryptEvent, verifySignature } from "./crypto.ts";
import { feishuTurnStream } from "./invoke-turn.ts";
import { type FeishuApi, type FeishuTarget, createFeishuApi } from "./feishu-api.ts";
import type { FeishuEventHeader } from "./model.ts";
import { normalizeFeishuMessage } from "./normalize.ts";
import { createThreadParticipants } from "../kit/thread-participants.ts";
import { FEISHU_AGENT_SCOPES, scopeSatisfied } from "./setup-mode.ts";
import {
  type FeishuMessage,
  type FeishuMessageEvent,
  type FeishuRoute,
  cloudEnvelope,
  defaultFeishuRoute,
  feishuEnvelope,
  placeKey,
  senderId,
} from "./parse.ts";
import { type FeishuFailure, defaultErrorMessage, settleFeishuPreview, feishuReply } from "./preview.ts";
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

/** The persisted turn intent (what the runner needs to re-execute it). */
interface StoredFeishuTurn extends TurnRecordBase {
  // `id` is the message_id (the platform delivery identity); `seq` carries arrival order.
  seq: number;
  baseText: string;
  /** The place whose history this turn reads (the chat, or the thread it was asked in); absent for a routed turn. */
  historyKey?: string;
  /** Asked in a group chat: the one kind of chat whose threads its tool may read. */
  group: boolean;
  /** When the ask was created (ms): this turn's read of its place ends there. */
  askAt: number;
  chatId: string;
  replyTo?: string;
  /** Source message to quote when queue feedback mounts. */
  replyInThread?: boolean;
  parentId?: string;
  /** The exchange a new thread was opened on: its session forks the one that holds it, at that ask. */
  forkOf?: { conversation: string; ask: string };
  /** The ROOM whose history this thread's first turn reads, read-only. */
  roomKey?: string;
  images: { msg: string; key: string }[];
  files: { msg: string; key: string; name?: string }[];
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
    typeof r.conversation === "string" &&
    typeof r.baseText === "string" &&
    (r.historyKey === undefined || typeof r.historyKey === "string") &&
    typeof r.group === "boolean" &&
    typeof r.askAt === "number" &&
    typeof r.chatId === "string" &&
    (r.replyTo === undefined || typeof r.replyTo === "string") &&
    (r.replyInThread === undefined || typeof r.replyInThread === "boolean") &&
    (r.parentId === undefined || typeof r.parentId === "string") &&
    (r.forkOf === undefined || (typeof r.forkOf.conversation === "string" && typeof r.forkOf.ask === "string")) &&
    (r.roomKey === undefined || typeof r.roomKey === "string") &&
    refs(r.images) &&
    refs(r.files) &&
    typeof r.attempts === "number"
  );
}

/** One accepted turn: the persisted intent. */
type PendingFeishuTurn = Omit<StoredFeishuTurn, "attempts">;

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
  const { appId, appSecret, route, onError } = opts;
  const baseUrl = opts.apiBaseUrl ?? profile.apiBase;
  const { kind } = profile;
  const label = `[${kind}]`;
  return ({ agent, sessionFor, recordedSession, stateDir: stateHome }) => {
    // Credential checks run when serving starts, not while the authored module is imported.
    if (!appId || !appSecret) {
      throw new Error(`${factoryName} requires appId + appSecret (developer console → Credentials & Basic Info)`);
    }
    const formatError = onError ?? defaultErrorMessage;
    // Shared with the send tools (registered below). A turn's own posts go through `placeApi`.
    const api = createFeishuApi({ kind, baseUrl, appId, appSecret });

    void api.listAppScopes().then(
      (scopes) => {
        const granted = (name: string): boolean =>
          scopes.some(
            (scope) =>
              scope.name === name && scope.grantStatus === 1 && (scope.type === undefined || scope.type === "tenant"),
          );
        const missing = FEISHU_AGENT_SCOPES.filter((entry) => !scopeSatisfied(entry, granted));
        if (missing.length === 0) {
          log.info(`${label} permissions: every agent scope granted — the agent hears its group chats`);
        }
        for (const entry of missing) log.warn(`${label} ${entry.request} is not granted — ${entry.withoutIt}`);
      },
      (error) => log.warn(`${label} could not inspect the app's permissions: ${String(error)}`),
    );
    const botOpenId = createBotIdentity({ api, appId, label, botFile: join(stateHome, "bot.json") });
    const decide = route ?? ((event: FeishuMessageEvent) => defaultFeishuRoute(event, { botOpenId: botOpenId() }));
    const threadParticipants = createThreadParticipants(join(stateHome, "thread-participants.json"), label);
    /** This channel's place key for a thread (the shared store is key-agnostic). */
    // The SAME identity the session uses (`placeKey`) — a thread's place.
    const threadKey = (chatId: string, threadId: string): string =>
      placeKey(kind, { chat_id: chatId, thread_id: threadId });
    const store = createTurnStore<StoredFeishuTurn>(join(stateHome, "turns.json"), {
      label,
      isRecord: isStoredFeishuTurn,
      order: (a, b) => a.seq - b.seq,
    });
    // Every message this channel took as input (a turn, a /stop): the dedup ring.
    const seen = createSeenRing(join(stateHome, "seen.json"), label);
    // A `/stop` is taken as input but is no discussion: a read leaves it out, the asks themselves are kept.
    const stops = createSeenRing(join(stateHome, "stops.json"), label);
    // Where each conversation's session read to: a turn folds its place from the ask its session was last sent.
    const asks = createAskLog<FeishuPosition>({
      label,
      path: join(stateHome, "asks.json"),
      messages: agent.messages,
      isPosition: isFeishuPosition,
      compare: compareFeishuPositions,
    });
    // Whose a message is, so a reply to it reaches that conversation's session.
    const owners = createMessageOwners({ label, path: join(stateHome, "owners.json") });
    const history = createFeishuPlaceHistory({
      api,
      appId,
      label,
      path: join(stateHome, "history.json"),
      isControl: (id) => stops.has(id),
    });
    // A group turn's room, for the thread-reading tool (`feishuThreads`): the chat it was asked in, and its threads.
    const rooms = createRoomThreads({
      list: (chatId) => history.threads(chatId),
      read: async (chatId, threadId) =>
        (await history.snapshot(feishuHistoryKey({ chatId, threadId }))).text ||
        `(thread ${threadId} shows no messages)`,
    });
    registerRoomThreads(kind, stateHome, rooms);
    /**
     * The client a turn posts through: what it posts into its place (answer, queue notice, stop feedback) is in the
     * turn's session already, so the place records it for that conversation and its next read leaves it out; another
     * conversation's read keeps it. The send tools use the plain client, so what the agent posts itself stays
     * discussion. A routed turn has no place and reads no history.
     */
    const placeApi = (turn: { historyKey?: string; conversation: string; id?: string }): FeishuApi =>
      turn.historyKey === undefined
        ? api
        : api.recordingSends((id) => {
            history.recordOutput(turn.historyKey as string, turn.conversation, id);
            owners.record(id, { conversation: turn.conversation, ...(turn.id === undefined ? {} : { ask: turn.id }) });
          });
    // Side tasks (stop feedback) run off the ingress path but drain in turnsIdle.
    const sideTasks = createTaskTracker(label);
    const targetOf = (r: PendingFeishuTurn): FeishuTarget => ({
      chatId: r.chatId,
      replyTo: r.replyTo,
      replyInThread: r.replyInThread,
    });

    // Tell the asker when a turn is dropped at the execution ceiling: the chain's end needs a signal, not just an
    // operator log line.
    const notifyDropped = (r: PendingFeishuTurn): void => {
      const body = "⚠️ I couldn’t complete an earlier request — please ask again.";
      void settleFeishuPreview(placeApi(r), targetOf(r), undefined, body).catch((e) =>
        log.warn(`${label} could not notify a dropped turn (conversation=${r.conversation}): ${String(e)}`),
      );
    };

    const runner = createTurnRunner<PendingFeishuTurn, StoredFeishuTurn, PlaceMessage>({
      label,
      store,
      // The read ends at the ask and starts after the ask its session was last sent.
      discussion: async (rec) => {
        if (rec.historyKey === undefined) return { text: "", folded: [] };
        const until = { at: rec.askAt, id: rec.id };
        const start = await readStart(asks, label, rec.conversation, recordedSession(rec.conversation), until);
        const fold = await history.fold({
          key: rec.historyKey,
          conversation: rec.conversation,
          budget: await foldBudget(agent, recordedSession(rec.conversation)),
          ...(start.after === undefined ? {} : { after: start.after }),
          until,
        });
        if (fold.unread) asks.forget(rec.conversation, rec.id);
        return start.unreadable === undefined ? fold : { ...fold, text: `${start.unreadable}\n${fold.text}`.trimEnd() };
      },
      seen,
      delivered: createSeenRing(join(stateHome, "delivered.json"), label),
      toStored: (intent) => ({ ...intent, attempts: 0 }),
      fromStored: ({ attempts: _a, ...intent }) => intent,
      where: (rec) => `chat=${rec.chatId}`,
      notifyDropped,
      acknowledgeHeld: (rec) => acknowledgeFeishuAsk(placeApi(rec), rec.id, label),
      // A group's answer quotes the first asker's message, so a later asker is told where theirs is.
      notifyShared: (rec) =>
        rec.replyTo === undefined
          ? Promise.resolve()
          : settleFeishuPreview(placeApi(rec), targetOf(rec), undefined, SHARED_ANSWER_NOTICE),
      deliverAnswer: (rec, answer) =>
        portJoin(() => settleFeishuPreview(placeApi(rec), targetOf(rec), undefined, answer)),
      execute: (rec, discussion, onAnswered, hooks) => {
        // Where a new thread forks from, asked once: the room's read and the thread's session both build on it.
        let forkSource: Promise<ForkSource> | undefined;
        const fork = (): Promise<ForkSource> =>
          (forkSource ??=
            rec.forkOf === undefined
              ? Promise.resolve(undefined)
              : threadForkSource(agent, recordedSession(rec.forkOf.conversation), rec.forkOf.ask));
        return Effect.promise(async () => {
          // What the room has said since the exchange this thread was opened on, read by the thread's first turn:
          // its session holds none of it, so the room's newest messages when nothing named one. The fork's own answer
          // is read again, since the room's session may have answered more after it.
          if (rec.roomKey === undefined) return undefined;
          // A thread with no session yet fails at its session step when the fork cannot be told. One that has a session
          // never asks, so the failure is said here, and the read falls back to the room's newest messages.
          const source =
            rec.forkOf === undefined
              ? undefined
              : await fork().catch((error: unknown) => {
                  log.warn(
                    `${label} could not tell where thread ${rec.conversation} forked from; reading the room's newest messages: ${String(error)}`,
                  );
                  return undefined;
                });
          const after =
            source === undefined || rec.forkOf === undefined
              ? undefined
              : asks.positionOf(rec.forkOf.conversation, rec.forkOf.ask);
          return history.fold({
            key: rec.roomKey,
            conversation: rec.conversation,
            budget: await foldBudget(agent, recordedSession(rec.conversation)),
            ...(after === undefined ? {} : { after }),
          });
        }).pipe(
          Effect.flatMap((room) => {
            const roomBlock = room?.text
              ? `[recent discussion in the room this thread was opened in:\n${room.text}\n]\n\n`
              : "";
            const prompt = `${roomBlock}${discussionBlock(discussion.text)}${rec.baseText}`;
            // Room messages FIRST: the collector keeps the TAIL under its cap, so the thread's own attachments win the
            // slots.
            const buffered = collectFoldedAttachments([...(room?.folded ?? []), ...discussion.folded], {
              images: rec.images.map((ref) => ({ messageId: ref.msg, key: ref.key })),
              files: rec.files.map((ref) => ({ messageId: ref.msg, key: ref.key })),
            });
            // A group turn under the default routing reads its chat's threads; a DM has none to read.
            const threadsRoom =
              rec.group && rec.historyKey !== undefined ? feishuPlaceOf(rec.historyKey).chatId : undefined;
            const turnApi = placeApi(rec);
            return hooks.reply(
              feishuTurnStream(
                agent,
                {
                  session: () => sessionFor(rec.conversation, { forkFrom: fork }),
                  ...(threadsRoom === undefined
                    ? {}
                    : { enter: (sessionId: string) => rooms.enter(sessionId, threadsRoom) }),
                  key: rec.id,
                  text: prompt,
                  steer: hooks,
                },
                {
                  api: turnApi,
                  chatId: rec.chatId,
                  filesDir: attachmentsDir(stateHome),
                  label,
                  appId,
                },
                { primary: { images: rec.images, files: rec.files, parentId: rec.parentId }, buffered },
              ),
              (events) => feishuReply(events, turnApi, targetOf(rec), formatError, label, onAnswered),
            );
          }),
        );
      },
    });
    registerFeishuApi(appId, kind, api);
    let seqCounter = runner.recover().reduce((max, r) => Math.max(max, r.seq), 0);

    // Who the agent has heard in a thread decides whether a bare message addresses it (the participant model), and it
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
        // Not lost: the turn that is summoned here reads it from the place's history.
        log.debug(`${label} not summoned — message ${m.message_id} (chat ${m.chat_id}, ${m.chat_type})`);
        return;
      }

      // A group's main timeline is one conversation per sender; a thread, a topic and a DM are one per place.
      const routed = r.conversation;
      const mainTimeline = m.chat_type === "group" && m.thread_id === undefined;
      const sender = senderId(event.sender);
      const own = mainTimeline ? senderConversation(placeKey(kind, m), sender) : placeKey(kind, m);
      // A reply to a message the table gives to a session belongs to that session, whoever replies.
      const named = mainTimeline && m.parent_id !== undefined ? owners.ownerOf(m.parent_id)?.conversation : undefined;
      const conversation = routed ?? named ?? own;
      // A new thread, under the default routing, starts from the exchange of the message it was opened on, and its first
      // turn reads the room. Read BEFORE this turn records its own participation below, or it is always false.
      const newThread =
        routed === undefined && m.thread_id !== undefined && !threadParticipants.agentSpokeIn(conversation);
      const opened = newThread && m.parent_id !== undefined ? owners.ownerOf(m.parent_id) : undefined;
      const forkOf =
        opened?.ask === undefined || opened.conversation === conversation
          ? undefined
          : { conversation: opened.conversation, ask: opened.ask };
      const roomKey = newThread ? feishuHistoryKey({ chatId: m.chat_id }) : undefined;
      // Every place's discussion under the default routing, a DM's too (what a send tool posted there is in no session);
      // a routed session's place is the router's to decide.
      const historyKey = route === undefined ? feishuHistoryKey(normalized.conversation) : undefined;
      // The platform stamps every message; acceptance time stands in only if a payload lacks it, and is still a bound
      // the ask was created before.
      const created = Number(m.create_time);
      const askAt = Number.isFinite(created) && created > 0 ? created : Date.now();
      const chatId = r.chatId ?? m.chat_id;
      const sameTarget = chatId === m.chat_id;
      // Answer where asked: quote in a group so the ask is identifiable among many speakers, stay plain in an
      // ordinary direct message, and stay inside a thread whenever the question came from one — a direct message's
      // thread is a place too, and relocating out of it is the silent move the model refuses.
      const replyTo = sameTarget && (m.chat_type === "group" || m.thread_id !== undefined) ? m.message_id : undefined;
      const replyInThread = replyTo !== undefined && m.thread_id !== undefined ? true : undefined;
      // Explicit user stop: a control action, never a turn — it must not queue behind the run it stops.
      if (isStopText(normalized.content.text.replace(/@\S+/g, " "))) {
        seen.add(m.message_id);
        stops.add(m.message_id);
        sideTasks.track(
          dispatchStop(agent, recordedSession(routed ?? own), label)
            .then((feedback) =>
              placeApi({ historyKey, conversation: routed ?? own })
                .sendText({ chatId, replyTo, replyInThread }, feedback)
                .then(() => undefined),
            )
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

      if (historyKey !== undefined) {
        asks.record(conversation, { key: m.message_id, at: { at: askAt, id: m.message_id } });
        owners.record(m.message_id, { conversation, ask: m.message_id });
      }
      runner.submit(
        {
          id: m.message_id,
          seq: ++seqCounter, // arrival order; the turn store replays by it
          conversation,
          baseText,
          ...(historyKey !== undefined ? { historyKey } : {}),
          group: m.chat_type === "group",
          askAt,
          chatId,
          replyTo,
          replyInThread,
          // A quote is the user explicitly pointing at something that may predate this session, so it is
          // always loaded.
          parentId: m.parent_id,
          ...(forkOf !== undefined ? { forkOf } : {}),
          ...(roomKey !== undefined && historyKey !== undefined ? { roomKey } : {}),
          images,
          files,
        },
        true,
      );

      // Answering inside a thread makes the agent a participant of it, which is what lets the NEXT bare message
      // address it without a mention.
      if (heard && replyInThread === true && sameTarget && r.conversation === undefined) {
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
  stateDir: string,
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
    // The platform's token: the Request URL reaches this instance, at the address it was sent to (Lark's, set by a
    // person where its configuration API is missing).
    recordReached(stateDir, req);

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
      // The scaffolded file reaches this under `start` with nothing set, so the error names both ways out.
      throw new Error(
        `${factoryName} receives by webhook and needs a non-empty verificationToken: \`fastagent deploy <host> --run\` ` +
          `or \`fastagent channels setup ${profile.kind} --ingress webhook\` captures ${profile.envPrefix}_VERIFICATION_TOKEN ` +
          `(console → Events & Callbacks has it too), or set channels.<name>.ingress to "connection" in the instance's ` +
          `fastagent.json to receive by WebSocket instead`,
      );
    }
    return createFeishuWebhookRoutes(profile, opts, createRuntime(ctx), ctx.stateDir);
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
