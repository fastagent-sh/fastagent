/**
 * First-party Slack channel: durable turns/context, files, and edited previews, over one runtime, with two ways in: the
 * Events API's signed HTTP Request URL, and Socket Mode (socket.ts).
 */
import { recordReached } from "../webhook-evidence.ts";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import type { ChannelContext, ChannelModule, LongConnectionChannelModule } from "../../channel.ts";
import { log } from "../../log.ts";
import { readBodyCapped } from "../body.ts";
import { text } from "../respond.ts";
import { secretEquals } from "../secret.ts";
import { createSeenRing } from "../kit/seen.ts";
import { signatureIsFresh } from "../kit/signature.ts";
import { createThreadParticipants } from "../kit/thread-participants.ts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { portJoin } from "../../effect-port.ts";
import { createTaskTracker } from "../kit/tasks.ts";
import { attachmentsDir } from "../kit/attachment-path.ts";
import { dispatchStop, isStopText } from "../kit/stop-command.ts";
import { codePointPrefix } from "../kit/text.ts";
import { createRoomThreads, registerRoomThreads } from "../kit/room-threads.ts";
import { createAskLog, readStart } from "../kit/ask-log.ts";
import { foldBudget } from "../kit/fold-budget.ts";
import type { PlaceMessage } from "../kit/place-history.ts";
import { createTurnRunner } from "../kit/turn-runner.ts";
import { type TurnRecordBase, createTurnStore } from "../kit/turn-store.ts";
import { discussionBlock } from "../kit/context-buffer.ts";
import {
  collectFoldedFiles,
  compareSlackTs,
  createSlackPlaceHistory,
  isSlackTs,
  slackHistoryKey,
  slackPlaceOf,
} from "./history.ts";
import { slackTurnStream } from "./invoke-turn.ts";
import { type OpenSlackSocket, connectSlackSocket } from "./socket.ts";
import {
  type SlackEventEnvelope,
  type SlackFile,
  type SlackMessageEvent,
  type SlackRoute,
  defaultSlackRoute,
  isSlackDirectMessage,
  isSlackGroupMessage,
  hasSlackMention,
  isSlackHumanMessage,
  mentionsSlackUser,
  stripSlackMentions,
  slackEnvelope,
  slackFileIds,
  slackMessageText,
  slackTeamId,
} from "./parse.ts";
import {
  type SlackFailure,
  type SlackRendering,
  defaultErrorMessage,
  deliverSlackAnswer,
  settleSlackPreview,
  slackReply,
} from "./preview.ts";
import { completeSlackReaction, resolveReactionEmojis, startSlackReaction } from "./reaction.ts";
import { registerSlackApi } from "./shared-api.ts";
import { type SlackApi, type SlackTarget, createSlackApi } from "./slack-api.ts";
import { createWelcomedUsers } from "./welcomed.ts";

export { defaultSlackRoute, slackEnvelope };

export type {
  SlackEventEnvelope,
  SlackFailure,
  SlackFile,
  SlackMessageEvent,
  SlackRendering,
  SlackRoute,
  SlackSocketChannelOptions,
};

const MAX_EVENT_BYTES = 1 << 20;
/**
 * Slack's own documented window — it re-signs every redelivery with a current timestamp, so a tight one costs nothing.
 */
const MAX_SIGNATURE_AGE_S = 5 * 60;
const DEFAULT_WELCOME = "👋 Hi! I'm an AI agent here to help. Ask a question or describe a task and I'll get to work.";

/** What `slackSocketChannel` is given: the policy of `slackChannel`, and the app-level token in place of its secret. */
interface SlackSocketChannelOptions extends SlackPolicyOptions {
  /** The app-level token (`xapp-…`, scope `connections:write`): opens the socket. */
  appToken: string;
}

/** `id`/`session`/`attempts`/`answer` come from the generic record, which is also where `answer` is validated. */
interface StoredSlackTurn extends TurnRecordBase {
  seq: number;
  baseText: string;
  /** The place whose history this turn reads (a channel's or DM's top level, or a thread); absent for a routed turn. */
  historyKey?: string;
  /** Asked in a channel, not a DM: the one kind of place whose threads its tool may read. */
  group: boolean;
  teamId: string;
  channelId: string;
  threadTs?: string;
  requesterUserId?: string;
  threadTitle?: string;
  fileIds: string[];
}

function isStoredSlackTurn(value: unknown): value is StoredSlackTurn {
  const turn = value as StoredSlackTurn;
  return (
    typeof turn?.id === "string" &&
    typeof turn.seq === "number" &&
    typeof turn.conversation === "string" &&
    typeof turn.baseText === "string" &&
    (turn.historyKey === undefined || typeof turn.historyKey === "string") &&
    typeof turn.group === "boolean" &&
    typeof turn.teamId === "string" &&
    typeof turn.channelId === "string" &&
    (turn.threadTs === undefined || typeof turn.threadTs === "string") &&
    (turn.requesterUserId === undefined || typeof turn.requesterUserId === "string") &&
    (turn.threadTitle === undefined || typeof turn.threadTitle === "string") &&
    Array.isArray(turn.fileIds) &&
    turn.fileIds.every((id) => typeof id === "string") &&
    typeof turn.attempts === "number"
  );
}

type PendingSlackTurn = Omit<StoredSlackTurn, "attempts">;

export interface SlackChannelOptions {
  /** Bot User OAuth Token (`xoxb-…`) used for replies and files. */
  botToken: string;
  /** App signing secret used to verify the raw Events API request body. */
  signingSecret: string;
  /**
   * `native` (default) uses Slack Agent streams for threaded replies; `classic` retains the compatibility renderer
   * based on one rate-limited edited message. A top-level target necessarily uses `classic`, because Slack streams
   * require a parent user message — a custom route reaches one either by returning `threadTs: null` or by redirecting
   * to another channel without naming a thread.
   */
  rendering?: SlackRendering;
  /** Optional footer for successful Agent replies. */
  aiDisclaimer?: string | false;
  /**
   * First-run direct-message welcome, sent once when a user first opens the DM (`app_home_opened`, `tab: "messages"`).
   */
  welcome?: string | false;
  /** Lightweight emoji ack on the user's triggering message: 👀 while working, ✅ when done. */
  reactionAck?: false | { processing?: string; completed?: string };
  /** Custom route policy. Providing it disables the default participant-model thread/context admission policy. */
  route?: (envelope: SlackEventEnvelope) => SlackRoute | null;
  /** Customer-facing failure formatter; full details always remain in operator logs. */
  onError?: (failure: SlackFailure) => string | undefined;
  /** Slack Web API base override for tests or an operator-controlled gateway. */
  apiBaseUrl?: string;
}

/** Verify Slack's v0 HMAC over the exact raw body and reject timestamps outside the replay window. */
export function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  signature: string,
  rawBody: string,
  nowMs = Date.now(),
): boolean {
  if (!/^v0=[a-f0-9]{64}$/i.test(signature)) return false;
  if (!signatureIsFresh(timestamp, MAX_SIGNATURE_AGE_S, nowMs)) return false;
  const expected = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  return secretEquals(signature, expected);
}

/**
 * The (channel, ts) of the user's triggering message, encoded in the logical turn id `team:channel:ts` (Slack ids
 * never contain a colon, so a 3-part split is exact).
 */
function messageRefOf(turnId: string): { channelId: string; ts: string } | undefined {
  const parts = turnId.split(":");
  return parts.length === 3 && parts[1] && parts[2] ? { channelId: parts[1], ts: parts[2] } : undefined;
}

/** How long an ingress may wait for `auth.test`: the Events API allows 3s to ACK, so this must fail well inside it. */
const AUTH_ACK_BUDGET_MS = 2_000;

/**
 * One `auth.test` per process — the workspace and bot identity every routing decision reads. Construction cannot
 * await Web API IO, so the promise is exposed two ways: {@link settled} for background work that can wait as long as
 * it takes, and {@link ready} for the ingress path, which must answer inside the ACK budget.
 */
interface SlackAuthentication {
  /**
   * REJECTS when `auth.test` failed, and every consumer must await or catch it. The rejection is already reported
   * once (an internal `catch` logs it), so this promise carries the failure for control flow, not for reporting it a
   * second time — a consumer that neither awaits nor catches drops a turn silently.
   */
  readonly settled: Promise<void>;
  /** {@link settled}, bounded by the Events API ACK budget: rejects rather than letting an ingress miss it. */
  ready(): Promise<void>;
  teamId(): string | undefined;
  botUserId(): string | undefined;
  botId(): string | undefined;
}

function createSlackAuthentication(api: ReturnType<typeof createSlackApi>, label: string): SlackAuthentication {
  let teamId: string | undefined;
  let botUserId: string | undefined;
  let botId: string | undefined;
  let state: "pending" | "ready" | "failed" = "pending";
  const settled = api.authTest().then(
    (identity) => {
      teamId = identity.teamId;
      botUserId = identity.userId;
      botId = identity.botId;
      state = "ready";
      log.info(`${label} authenticated${identity.teamId ? ` for workspace ${identity.teamId}` : ""}`);
    },
    (error) => {
      state = "failed";
      throw new Error(`Slack auth.test failed — fix SLACK_BOT_TOKEN before accepting events: ${String(error)}`, {
        cause: error,
      });
    },
  );
  void settled.catch((error) => log.error(`${label} ${String(error)}`));
  return {
    settled,
    teamId: () => teamId,
    botUserId: () => botUserId,
    botId: () => botId,
    ready: () =>
      state !== "pending"
        ? settled
        : new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(
              () => reject(new Error("Slack auth.test did not finish inside the Events API ACK budget")),
              AUTH_ACK_BUDGET_MS,
            );
            void settled.then(
              () => {
                clearTimeout(timeout);
                resolve();
              },
              (error) => {
                clearTimeout(timeout);
                reject(error);
              },
            );
          }),
  };
}

/** What a Slack channel is told besides how its events arrive: the policy both ways share. */
type SlackPolicyOptions = Omit<SlackChannelOptions, "signingSecret">;

/** The policy as the runtime reads it: defaults applied and what can be refused refused, at construction. */
function resolveSlackPolicy(options: SlackPolicyOptions) {
  const { rendering = "native", welcome = DEFAULT_WELCOME, reactionAck = {} } = options;
  if (!(["native", "classic"] as const).includes(rendering)) {
    throw new Error('slackChannel rendering must be "native" or "classic"');
  }
  if (welcome !== false && typeof welcome !== "string") {
    throw new Error("slackChannel welcome must be a string or false");
  }
  return {
    botToken: options.botToken,
    rendering,
    welcome,
    reactionEmojis: resolveReactionEmojis(reactionAck),
    aiDisclaimer: options.aiDisclaimer,
    route: options.route,
    onError: options.onError,
    apiBaseUrl: options.apiBaseUrl ?? "https://slack.com/api",
  };
}

/** What both ways of receiving hand an event to: everything of a Slack channel but how its events arrive. */
interface SlackRuntime {
  /**
   * Take one Events API envelope (`event_callback`): durable before it returns, and rejecting when it cannot be taken
   * (Slack authentication unavailable inside the ACK budget), so the transport leaves it unacknowledged and Slack
   * sends it again.
   */
  ingest(envelope: SlackEventEnvelope): Promise<void>;
  /** Resolves once the turns and side tasks accepted so far have ended: the test/observability seam. */
  turnsIdle(): Promise<void>;
}

function createSlackRuntime(
  policy: ReturnType<typeof resolveSlackPolicy>,
  { agent, sessionFor, recordedSession, stateDir: stateHome }: ChannelContext,
): SlackRuntime {
  const { botToken, rendering, welcome, reactionEmojis, aiDisclaimer, route, onError, apiBaseUrl } = policy;
  if (!botToken) throw new Error("slackChannel requires a non-empty botToken (Bot User OAuth Token)");

  const label = "[slack]";
  const formatError = onError ?? defaultErrorMessage;
  const api = createSlackApi({ botToken, baseUrl: apiBaseUrl });
  registerSlackApi(botToken, api); // the send tool delivers through this one (shared-api.ts)
  const auth = createSlackAuthentication(api, label);

  // Side tasks (stop feedback, DM welcomes) run off the ACK path but drain in turnsIdle.
  const sideTasks = createTaskTracker(label);
  const seen = createSeenRing(join(stateHome, "seen.json"), label);
  // A `/stop` is taken as input but is no discussion: a read leaves it out, the asks themselves are kept.
  const stops = createSeenRing(join(stateHome, "stops.json"), label);
  const threadParticipants = createThreadParticipants(join(stateHome, "thread-participants.json"), label);
  /**
   * A thread's participation is keyed by the CONVERSATION it describes — "the agent answered here" is a claim about
   * a memory, so the two must not be re-keyable independently.
   */
  const threadKey = (teamId: string, channelId: string, threadTs: string): string =>
    `${teamId}:${channelId}:${threadTs}`;
  const welcomed = createWelcomedUsers(join(stateHome, "welcomed.json"), label);
  // Where each conversation's session read to: a turn folds its place from the ask its session was last sent.
  const asks = createAskLog<string>({
    label,
    path: join(stateHome, "asks.json"),
    messages: agent.messages,
    isPosition: isSlackTs,
    compare: compareSlackTs,
  });
  const history = createSlackPlaceHistory({
    api,
    self: () => ({ userId: auth.botUserId(), botId: auth.botId() }),
    label,
    path: join(stateHome, "history.json"),
    isControl: (key, ts) => {
      const place = slackPlaceOf(key);
      return stops.has(`${place.teamId}:${place.channelId}:${ts}`);
    },
  });
  // A group turn's room, for the thread-reading tool (`slackThreads`): the channel it was asked in, and its threads.
  const rooms = createRoomThreads({
    list: (room) => history.threads(room),
    read: async (room, threadTs) => {
      if (!/^\d+\.\d+$/.test(threadTs)) {
        throw new Error(
          `"${threadTs}" is not a Slack thread id: pass a thread's id from the list (like 1712345678.123456)`,
        );
      }
      const { teamId, channelId } = slackPlaceOf(room);
      const key = slackHistoryKey(teamId, { channelId, threadTs });
      return (await history.snapshot(key)).text || `(thread ${threadTs} shows no messages)`;
    },
  });
  registerRoomThreads("slack", stateHome, rooms);
  /**
   * The client a turn posts through: what it posts (answer, queue notice, stop feedback) is in the turn's session
   * already, so the place it LANDS in records it for that conversation, and its next read leaves it out — an answer to
   * a channel's top-level ask lands in the thread it opens. Another conversation's read keeps it. The send tool uses
   * the plain client, so what the agent posts itself stays discussion. A routed turn has no place and reads no history.
   */
  const placeApi = (turn: { historyKey?: string; teamId: string; conversation: string }): SlackApi =>
    turn.historyKey === undefined
      ? api
      : api.recordingSends((where, ts) =>
          history.recordOutput(slackHistoryKey(turn.teamId, where), turn.conversation, ts),
        );
  const store = createTurnStore<StoredSlackTurn>(join(stateHome, "turns.json"), {
    label,
    isRecord: isStoredSlackTurn,
    order: (a, b) => a.seq - b.seq,
  });
  const decide = route ?? defaultSlackRoute;
  /** A channel turn under the default routing reads its channel's threads; a DM has none to read. */
  const enterRoom = (turn: PendingSlackTurn): { enter?: (sessionId: string) => () => void } => {
    if (!turn.group || turn.historyKey === undefined) return {};
    const { teamId, channelId } = slackPlaceOf(turn.historyKey);
    const room = slackHistoryKey(teamId, { channelId });
    return { enter: (sessionId) => rooms.enter(sessionId, room) };
  };
  const targetOf = (turn: PendingSlackTurn): SlackTarget => ({
    channelId: turn.channelId,
    threadTs: turn.threadTs,
    recipientUserId: turn.requesterUserId,
    recipientTeamId: turn.teamId,
  });

  const notifyDropped = (turn: PendingSlackTurn): void => {
    void settleSlackPreview(
      placeApi(turn),
      targetOf(turn),
      undefined,
      "⚠️ I couldn’t complete an earlier request — please ask again.",
    ).catch((error) => log.warn(`${label} could not notify a dropped turn: ${String(error)}`));
  };

  const runner = createTurnRunner<PendingSlackTurn, StoredSlackTurn, PlaceMessage>({
    label,
    store,
    // The read ends at the ask (`messageRefOf`: the ts of the message that asked) and starts after the ask its session
    // was last sent.
    discussion: async (turn) => {
      const ask = messageRefOf(turn.id);
      if (turn.historyKey === undefined || ask === undefined) return { text: "", folded: [] };
      const start = await readStart(asks, label, turn.conversation, recordedSession(turn.conversation), ask.ts);
      const fold = await history.fold({
        key: turn.historyKey,
        conversation: turn.conversation,
        budget: await foldBudget(agent, recordedSession(turn.conversation)),
        ...(start.after === undefined ? {} : { after: start.after }),
        until: ask.ts,
      });
      if (fold.unread) asks.forget(turn.conversation, turn.id);
      return start.unreadable === undefined ? fold : { ...fold, text: `${start.unreadable}\n${fold.text}`.trimEnd() };
    },
    seen,
    delivered: createSeenRing(join(stateHome, "delivered.json"), label),
    toStored: (intent) => ({ ...intent, attempts: 0 }),
    fromStored: ({ attempts: _attempts, ...intent }) => intent,
    where: (turn) => `channel=${turn.channelId}`,
    // Leave the intent untouched when Slack auth failed.
    beforeRun: async (turn) => {
      try {
        await auth.settled;
        return true;
      } catch (error) {
        log.error(`${label} deferring durable turn ${turn.id} because Slack authentication failed: ${String(error)}`);
        return false;
      }
    },
    notifyDropped,
    deliverAnswer: (turn, answer) =>
      portJoin(async () => {
        await deliverSlackAnswer(placeApi(turn), targetOf(turn), answer);
        // The 👀 on the asker's message was added by the run that produced this answer, and `execute`'s
        // acquire/release — the only thing that turns it into ✅ — is not on this path.
        const messageRef = messageRefOf(turn.id);
        if (reactionEmojis && messageRef) {
          await completeSlackReaction({
            api,
            channelId: messageRef.channelId,
            ts: messageRef.ts,
            emojis: reactionEmojis,
            label,
          });
        }
      }),
    execute: (turn, discussion, onAnswered, hooks) => {
      const messageRef = messageRefOf(turn.id);
      return Effect.acquireUseRelease(
        portJoin(async () =>
          reactionEmojis && messageRef
            ? startSlackReaction({
                api,
                channelId: messageRef.channelId,
                ts: messageRef.ts,
                emojis: reactionEmojis,
                label,
              })
            : undefined,
        ),
        () =>
          Effect.scoped(
            hooks.reply(
              slackTurnStream(
                agent,
                {
                  session: () => sessionFor(turn.conversation),
                  ...enterRoom(turn),
                  key: turn.id,
                  text: `${discussionBlock(discussion.text)}${turn.baseText}`,
                  steer: hooks,
                },
                { api, channelId: turn.channelId, filesDir: attachmentsDir(stateHome), label },
                {
                  primaryFileIds: turn.fileIds,
                  buffered: collectFoldedFiles(discussion.folded, new Set(turn.fileIds)),
                },
              ),
              (events) =>
                slackReply(events, placeApi(turn), targetOf(turn), formatError, {
                  rendering,
                  threadTitle: turn.threadTitle,
                  disclaimer: aiDisclaimer,
                  label,
                  onAnswered,
                }),
            ),
          ),
        (reaction, exit) =>
          portJoin(async () => {
            if (Exit.isSuccess(exit)) await reaction?.complete();
            else await reaction?.remove();
          }).pipe(
            // A release does not fail: its defect would make the turn's typed failure one too. Unreachable while
            // the reaction's `complete` and `remove` catch their own failures (reaction.ts).
            Effect.catchTag("PortFailure", (error) =>
              Effect.sync(() => log.warn(`${label} could not settle the Slack reaction: ${String(error.cause)}`)),
            ),
          ),
      );
    },
  });
  let seq = runner.recover().reduce((maximum, turn) => Math.max(maximum, turn.seq), 0);

  // Acceptance touches no network, so it stays synchronous inside Slack's ACK window and the delivery dedup ring
  // alone is enough.
  const acceptEvent = (envelope: SlackEventEnvelope): void => {
    const event = envelope.event;
    if (!isSlackHumanMessage(event)) return;
    const botUserId = auth.botUserId();
    if (botUserId && event.user === botUserId) return;
    const teamId = slackTeamId(envelope) ?? auth.teamId();
    if (!teamId) {
      log.warn(`${label} ignored message ${event.ts}: event carried no workspace/enterprise identity`);
      return;
    }
    const logicalId = `${teamId}:${event.channel}:${event.ts}`;
    if (seen.has(logicalId)) {
      log.debug(`${label} duplicate logical message ${logicalId} — skipping`);
      return;
    }

    const group = isSlackGroupMessage(event);
    const direct = isSlackDirectMessage(event);
    const rootTs = event.thread_ts ?? event.ts;
    // Listening is not speaking: every message the channel can see refines who takes part in its thread, whether or
    // not it is answered.
    if (group && event.thread_ts !== undefined) {
      threadParticipants.merge(threadKey(teamId, event.channel, event.thread_ts), { humans: [event.user] });
    }

    let routed = decide(envelope);
    const addressesSomeone = hasSlackMention(event.text ?? "");
    const structurallyMentionsBot = botUserId !== undefined && mentionsSlackUser(event.text ?? "", botUserId);
    // app_mention and message.* subscriptions can overlap.
    if (!routed && route === undefined && group && event.type === "message" && structurallyMentionsBot) routed = {};
    // The participant model's thread rule: a bare message reaches the agent while it takes part and has not
    // heard a second human.
    if (
      !routed &&
      route === undefined &&
      group &&
      event.thread_ts !== undefined &&
      event.type !== "app_mention" &&
      // Mentioning only other people is targeted discussion, never an ask — the same guard Feishu applies with
      // `hasMentions`.
      !addressesSomeone &&
      threadParticipants.admitsBareMessage(threadKey(teamId, event.channel, event.thread_ts))
    ) {
      routed = {};
    }
    if (!routed) {
      // Not lost: the turn that is summoned here reads it from the place's history.
      log.debug(`${label} not summoned — message ${logicalId}`);
      return;
    }

    const targetChannel = routed.channelId ?? event.channel;
    const sameChannel = targetChannel === event.channel;
    // Answer where asked.
    const defaultThread = event.thread_ts ?? event.ts;
    const threadTs =
      routed.threadTs === null ? undefined : (routed.threadTs ?? (sameChannel ? defaultThread : undefined));
    const defaultConversation = threadKey(teamId, event.channel, rootTs);
    // Every place's discussion under the default routing, a DM's too (what a send tool posted there is in no session);
    // a routed session's place is the router's to decide.
    const historyKey =
      route === undefined && (group || direct)
        ? slackHistoryKey(teamId, { channelId: event.channel, threadTs: event.thread_ts })
        : undefined;
    // Explicit user stop: a control action, never a turn — it must not queue behind the run it stops.
    if (isStopText(stripSlackMentions(event.text ?? ""))) {
      seen.add(logicalId);
      stops.add(logicalId);
      const target: SlackTarget = { channelId: event.channel, threadTs: event.thread_ts };
      sideTasks.track(
        dispatchStop(agent, recordedSession(routed.conversation ?? defaultConversation), label)
          .then((feedback) =>
            placeApi({ historyKey, teamId, conversation: routed.conversation ?? defaultConversation })
              .postMessage(target, feedback)
              .then(() => undefined),
          )
          .catch((error) => log.warn(`${label} stop feedback failed: ${String(error)}`)),
      );
      return;
    }
    const fileIds = slackFileIds(event);
    const baseText = routed.text ?? slackEnvelope(envelope);
    if (!baseText.trim() && fileIds.length === 0) return;
    const threadTitle =
      direct && event.thread_ts === undefined
        ? codePointPrefix(stripSlackMentions(slackMessageText(event), "").replace(/\s+/g, " ").trim(), 80)
        : undefined;

    const conversation = routed.conversation ?? defaultConversation;
    if (historyKey !== undefined) asks.record(conversation, { key: logicalId, at: event.ts });
    runner.submit(
      {
        id: logicalId,
        seq: ++seq,
        conversation,
        baseText,
        ...(historyKey !== undefined ? { historyKey } : {}),
        group,
        teamId,
        channelId: targetChannel,
        threadTs,
        requesterUserId: event.user,
        threadTitle: threadTitle || undefined,
        fileIds,
      },
      true,
    );

    // Answering inside a GROUP thread makes the agent a participant of it, which is what lets the NEXT bare message
    // address it without a mention.
    if (
      group &&
      threadTs !== undefined &&
      sameChannel &&
      routed.conversation === undefined &&
      routed.threadTs === undefined
    ) {
      // The ASKER counts as heard in this thread too, and both halves are written together so the record can never
      // say "the agent takes part and nobody has spoken".
      threadParticipants.merge(threadKey(teamId, event.channel, threadTs), {
        agentSpoke: true,
        humans: [event.user],
      });
    }
  };

  // First-run DM welcome: app_home_opened(tab="messages") signals a DM open. Post once per user.
  const welcomeInFlight = new Set<string>();
  const maybeWelcome = (envelope: SlackEventEnvelope): void => {
    if (welcome === false) return;
    const body = welcome.trim();
    if (!body) return;
    const event = envelope.event;
    if (!event) return;
    if (event.type !== "app_home_opened" || event.tab !== "messages") return;
    const userId = event.user;
    const channelId = event.channel;
    if (!userId || !channelId) return;
    const teamId = slackTeamId(envelope) ?? auth.teamId();
    if (!teamId) return;
    const id = `${teamId}:${userId}`;
    if (welcomed.has(teamId, userId) || welcomeInFlight.has(id)) return;
    // Reserve in-memory so rapid re-opens don't double-post; persist to the durable set only on a successful post,
    // so a failed post simply retries on the next open.
    welcomeInFlight.add(id);
    sideTasks.track(
      api
        .postMarkdown({ channelId }, body)
        .then(() => {
          welcomed.add(teamId, userId);
          log.info(`${label} sent first-run welcome to ${id}`);
        })
        .catch((error) =>
          log.warn(`${label} could not send first-run welcome (retries on next open): ${String(error)}`),
        )
        .finally(() => {
          welcomeInFlight.delete(id);
        }),
    );
  };

  return {
    ingest: async (envelope) => {
      await auth.ready();
      maybeWelcome(envelope);
      acceptEvent(envelope);
    },
    turnsIdle: () => Promise.all([runner.idle(), sideTasks.drain()]).then(() => undefined),
  };
}

/** Build a Slack channel that receives by the Events API's HTTP Request URL: signed requests in, durable turns out. */
export function slackChannel(options: SlackChannelOptions): ChannelModule {
  const { signingSecret } = options;
  const policy = resolveSlackPolicy(options);
  return (ctx) => {
    if (!signingSecret)
      throw new Error("slackChannel requires a non-empty signingSecret (Basic Information → App Credentials)");
    const runtime = createSlackRuntime(policy, ctx);
    const { stateDir: stateHome } = ctx;
    const handler = async (request: Request): Promise<Response> => {
      if (request.method !== "POST") return text("POST only\n", 405);
      const body = await readBodyCapped(request, MAX_EVENT_BYTES);
      if ("tooLarge" in body) return text("payload too large\n", 413);
      const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";
      const signature = request.headers.get("x-slack-signature") ?? "";
      if (!verifySlackSignature(signingSecret, timestamp, signature, body.text)) {
        log.warn("[slack] rejected an event with an invalid/stale X-Slack-Signature");
        return text("invalid signature\n", 401);
      }
      // Slack signed it: the Request URL a person set reaches this instance, at the address it was sent to.
      recordReached(stateHome, request);

      let envelope: SlackEventEnvelope;
      try {
        envelope = JSON.parse(body.text) as SlackEventEnvelope;
        if (typeof envelope !== "object" || envelope === null) throw new Error("not an object");
      } catch {
        return text("invalid json\n", 400);
      }
      if (envelope.type === "url_verification" && typeof envelope.challenge === "string") {
        return Response.json({ challenge: envelope.challenge });
      }
      if (envelope.type !== "event_callback") return new Response(null, { status: 200 });
      try {
        await runtime.ingest(envelope);
      } catch (error) {
        log.error(`[slack] refusing to ACK an event because Slack authentication is unavailable: ${String(error)}`);
        return text("slack authentication unavailable\n", 503);
      }
      return new Response(null, { status: 200 });
    };
    (handler as typeof handler & { turnsIdle?: () => Promise<void> }).turnsIdle = runtime.turnsIdle;
    return { "POST /slack": handler };
  };
}

/**
 * Build a Slack channel that receives by Socket Mode: the process opens a WebSocket to Slack with the app-level token
 * and takes its events there, so no public URL and no signing secret are involved. An app in Socket Mode receives over
 * the socket alone: it has no Request URL to point anywhere else.
 */
export function slackSocketChannel(
  options: SlackSocketChannelOptions,
  /** Internal seam for deterministic tests: the socket the connection opens. */
  deps: { openSocket?: OpenSlackSocket } = {},
): LongConnectionChannelModule {
  const policy = resolveSlackPolicy(options);
  const { appToken } = options;
  return {
    name: "slack socket mode",
    connect(ctx, signal) {
      if (!/^xapp-/.test(appToken)) {
        throw new Error(
          "slackSocketChannel requires an app-level token (xapp-…, scope connections:write: Basic Information → " +
            "App-Level Tokens), not a bot token",
        );
      }
      const runtime = createSlackRuntime(policy, ctx);
      return connectSlackSocket(
        {
          apiBaseUrl: policy.apiBaseUrl,
          appToken,
          ingest: runtime.ingest,
          ...(deps.openSocket === undefined ? {} : { openSocket: deps.openSocket }),
        },
        signal,
      );
    },
  };
}
