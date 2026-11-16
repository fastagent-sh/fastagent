/**
 * First-party Slack channel: durable turns/context, files, and edited previews, over one runtime, with two ways in:
 * Socket Mode (`slack()`, socket.ts), and the Events API's signed HTTP Request URL (`slackChannel`).
 */
import { createHmac } from "node:crypto";
import { join } from "node:path";
import type { ChannelContext, ConnectionChannel, RouteChannel } from "../../channel.ts";
import { type Needs, needs } from "../../needs.ts";
import { log } from "../../log.ts";
import { text } from "../respond.ts";
import { secretEquals } from "../secret.ts";
import { createSeenRing, createThreadParticipants } from "../kit/state.ts";
import { createJsonWebhookRoute, signatureIsFresh } from "../kit/ingress.ts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { joinPromise } from "../../promise-bridge.ts";
import { attachmentsDir, codePointPrefix } from "../kit/text.ts";
import { type SessionPlaces, createSessionPlaces } from "../kit/history.ts";
import { DROPPED_TURN_NOTICE, createTurnRunner, dispatchStop, isStopText } from "../kit/turn.ts";
import { type TurnRecordBase, createTurnStore } from "../kit/turn-store.ts";
import { createSlackHistory, slackHistoryKey } from "./history.ts";
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
  defaultErrorMessage,
  deliverSlackAnswer,
  settleSlackPreview,
  slackReply,
} from "./preview.ts";
import { completeSlackReaction, resolveReactionEmojis, startSlackReaction } from "./reaction.ts";
import { slackTools } from "./tools.ts";
import { type SlackApi, type SlackTarget, createSlackApi } from "./slack-api.ts";
import { createWelcomedUsers } from "./welcomed.ts";

export { defaultSlackRoute, slackEnvelope };

export type { SlackEventEnvelope, SlackFailure, SlackFile, SlackMessageEvent, SlackRoute, SlackSocketChannelOptions };

const MAX_EVENT_BYTES = 1 << 20;
/**
 * Slack's own documented window — it re-signs every redelivery with a current timestamp, so a tight one costs nothing.
 */
const MAX_SIGNATURE_AGE_S = 5 * 60;
const DEFAULT_WELCOME = "👋 Hi! I'm an AI agent here to help. Ask a question or describe a task and I'll get to work.";

/** What `slackSocket` is given: the policy of `slackChannel`, and the app-level token in place of its secret. */
interface SlackSocketChannelOptions extends SlackPolicyOptions {
  /** The app-level token (`xapp-…`, scope `connections:write`): opens the socket. */
  appToken: string;
}

/** `id`/`session`/`attempts`/`answer` come from the generic record, which is also where `answer` is validated. */
interface StoredSlackTurn extends TurnRecordBase {
  seq: number;
  baseText: string;
  /** Where it was asked (a channel's or DM's top level, or a thread): the place its `history` tool reads. */
  place: string;
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
    typeof turn.place === "string" &&
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
  const { welcome = DEFAULT_WELCOME, reactionAck = {} } = options;
  if (welcome !== false && typeof welcome !== "string") {
    throw new Error("slackChannel welcome must be a string or false");
  }
  return {
    botToken: options.botToken,
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
  /** Where each session's turn runs, for the `history` tool. */
  places: SessionPlaces;
  /** Reads one of its places, for the `history` tool. */
  history: ReturnType<typeof createSlackHistory>;
}

function createSlackRuntime(
  policy: ReturnType<typeof resolveSlackPolicy>,
  api: SlackApi,
  { agent, sessionFor, recordedSession, stateDir: stateHome }: ChannelContext,
): SlackRuntime {
  const { botToken, welcome, reactionEmojis, aiDisclaimer, route, onError } = policy;
  if (!botToken) throw new Error("slackChannel requires a non-empty botToken (Bot User OAuth Token)");

  const label = "[slack]";
  const formatError = onError ?? defaultErrorMessage;
  const auth = createSlackAuthentication(api, label);

  const seen = createSeenRing(join(stateHome, "seen.json"), label);
  const threadParticipants = createThreadParticipants(join(stateHome, "thread-participants.json"), label);
  /**
   * A thread's participation is keyed by the CONVERSATION it describes — "the agent answered here" is a claim about
   * a memory, so the two must not be re-keyable independently.
   */
  const threadKey = (teamId: string, channelId: string, threadTs: string): string =>
    `${teamId}:${channelId}:${threadTs}`;
  const welcomed = createWelcomedUsers(join(stateHome, "welcomed.json"), label);
  const places = createSessionPlaces();
  const history = createSlackHistory({
    api,
    self: () => ({ userId: auth.botUserId(), botId: auth.botId() }),
    label,
  });
  const store = createTurnStore<StoredSlackTurn>(join(stateHome, "turns.json"), {
    label,
    isRecord: isStoredSlackTurn,
    order: (a, b) => a.seq - b.seq,
  });
  const decide = route ?? defaultSlackRoute;
  const targetOf = (turn: PendingSlackTurn): SlackTarget => ({
    channelId: turn.channelId,
    threadTs: turn.threadTs,
    recipientUserId: turn.requesterUserId,
    recipientTeamId: turn.teamId,
  });

  const notifyDropped = (turn: PendingSlackTurn): void => {
    void settleSlackPreview(api, targetOf(turn), undefined, DROPPED_TURN_NOTICE).catch((error) =>
      log.warn(`${label} could not notify a dropped turn: ${String(error)}`),
    );
  };

  const runner = createTurnRunner<StoredSlackTurn>({
    label,
    store,
    seen,
    delivered: createSeenRing(join(stateHome, "delivered.json"), label),
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
      joinPromise(async () => {
        await deliverSlackAnswer(api, targetOf(turn), answer);
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
    execute: (turn, onAnswered, hooks) => {
      const messageRef = messageRefOf(turn.id);
      return Effect.acquireUseRelease(
        joinPromise(async () =>
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
                  enter: (sessionId) => places.enter(sessionId, turn.place),
                  key: turn.id,
                  text: turn.baseText,
                  steer: hooks,
                },
                { api, channelId: turn.channelId, filesDir: attachmentsDir(stateHome), label },
                turn.fileIds,
              ),
              (events) =>
                slackReply(events, api, targetOf(turn), formatError, {
                  threadTitle: turn.threadTitle,
                  disclaimer: aiDisclaimer,
                  label,
                  onAnswered,
                }),
            ),
          ),
        (reaction, exit) =>
          joinPromise(async () => {
            if (Exit.isSuccess(exit)) await reaction?.complete();
            else await reaction?.remove();
          }).pipe(
            // A release does not fail: its defect would make the turn's typed failure one too. Unreachable while
            // the reaction's `complete` and `remove` catch their own failures (reaction.ts).
            Effect.catchTag("PromiseFailure", (error) =>
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
    const place = slackHistoryKey(teamId, { channelId: event.channel, threadTs: event.thread_ts });
    // Explicit user stop: a control action, never a turn — it must not queue behind the run it stops.
    if (isStopText(stripSlackMentions(event.text ?? ""))) {
      seen.add(logicalId);
      const target: SlackTarget = { channelId: event.channel, threadTs: event.thread_ts };
      runner.track(
        dispatchStop(agent, recordedSession(routed.conversation ?? defaultConversation), label)
          .then((feedback) => api.postMessage(target, feedback).then(() => undefined))
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
    runner.submit(
      {
        id: logicalId,
        seq: ++seq,
        conversation,
        baseText,
        place,
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

  /**
   * Slack's own stop button on a working agent session (`agent_session_stopped`): stops the thread's conversation, as a
   * `stop` message does. Under a custom route a thread may talk in another session; its stop is the route's to say.
   */
  const stopSession = (envelope: SlackEventEnvelope): void => {
    const event = envelope.event;
    if (event?.type !== "agent_session_stopped" || !event.channel || !event.thread_ts) return;
    const teamId = slackTeamId(envelope) ?? auth.teamId();
    if (!teamId) return;
    const conversation = threadKey(teamId, event.channel, event.thread_ts);
    const target: SlackTarget = { channelId: event.channel, threadTs: event.thread_ts };
    runner.track(
      dispatchStop(agent, recordedSession(conversation), label)
        .then((feedback) => api.postMessage(target, feedback).then(() => undefined))
        .catch((error) => log.warn(`${label} stop feedback failed: ${String(error)}`)),
    );
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
    runner.track(
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
      stopSession(envelope);
      acceptEvent(envelope);
    },
    turnsIdle: runner.idle,
    places,
    history,
  };
}

/**
 * A Slack channel receiving the way `receive` says, and its tools, over one client: `send` posts through it, and
 * `history` reads the place each turn of the runtime the channel mounts runs in.
 */
function withTools<C>(
  policy: ReturnType<typeof resolveSlackPolicy>,
  receive: (runtime: (ctx: ChannelContext) => SlackRuntime) => C,
): C & { tools: ReturnType<typeof slackTools> } {
  const api = createSlackApi({ botToken: policy.botToken, baseUrl: policy.apiBaseUrl });
  let mounted: SlackRuntime | undefined;
  const channel = receive((ctx) => {
    mounted = createSlackRuntime(policy, api, ctx);
    return mounted;
  });
  return { ...channel, tools: slackTools(api, () => mounted) };
}

/**
 * Build a Slack channel that receives by the Events API's HTTP Request URL at `POST /slack`: signed requests in,
 * durable turns out. Whoever hosts it sets that Request URL on the app: FastAgent registers no URL.
 */
export function slackChannel(options: SlackChannelOptions): RouteChannel {
  const { signingSecret } = options;
  return withTools(resolveSlackPolicy(options), (runtimeFor) => ({
    routes(ctx) {
      if (!signingSecret)
        throw new Error("slackChannel requires a non-empty signingSecret (Basic Information → App Credentials)");
      const runtime = runtimeFor(ctx);
      const handler = createJsonWebhookRoute<SlackEventEnvelope>({
        maxBytes: MAX_EVENT_BYTES,
        turnsIdle: runtime.turnsIdle,
        verifyRaw: (request, rawBody) => {
          const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";
          const signature = request.headers.get("x-slack-signature") ?? "";
          if (!verifySlackSignature(signingSecret, timestamp, signature, rawBody)) {
            log.warn("[slack] rejected an event with an invalid/stale X-Slack-Signature");
            return text("invalid signature\n", 401);
          }
          return undefined;
        },
        handle: async (_request, _raw, envelope) => {
          if (typeof envelope !== "object" || envelope === null) return text("invalid json\n", 400);
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
        },
      });
      return { "POST /slack": handler };
    },
  }));
}

/**
 * A Slack channel that receives by Socket Mode, given its tokens: the process opens a WebSocket to Slack with the
 * app-level token and takes its events there, so no public URL and no signing secret are involved. An app in Socket
 * Mode receives over the socket alone: it has no Request URL to point anywhere else.
 */
export function slackSocket(
  options: SlackSocketChannelOptions,
  /** Internal seam for deterministic tests: the socket the connection opens. */
  deps: { openSocket?: OpenSlackSocket } = {},
): ConnectionChannel {
  const policy = resolveSlackPolicy(options);
  const { appToken } = options;
  return withTools(policy, (runtimeFor) => ({
    connect(ctx, signal) {
      if (!/^xapp-/.test(appToken)) {
        throw new Error(
          "the Slack channel needs an app-level token (xapp-…, scope connections:write: Basic Information → " +
            "App-Level Tokens) in SLACK_APP_TOKEN, not a bot token",
        );
      }
      const runtime = runtimeFor(ctx);
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
  }));
}

/** What `slack()` is given: the policy, the tokens being `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`. */
export type SlackOptions = Omit<SlackSocketChannelOptions, "botToken" | "appToken">;

/**
 * The Slack channel `fastagent.config.ts` declares: the app `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` name, over Socket
 * Mode, and its `send` and `threads` tools.
 */
export function slack(options: SlackOptions = {}): Needs<ConnectionChannel> {
  return needs(
    [
      { name: "SLACK_BOT_TOKEN", description: "The Bot User OAuth Token (xoxb-…)" },
      { name: "SLACK_APP_TOKEN", description: "An app-level token (xapp-…) with connections:write, for Socket Mode" },
    ],
    ({ SLACK_BOT_TOKEN, SLACK_APP_TOKEN }) =>
      slackSocket({ ...options, botToken: SLACK_BOT_TOKEN, appToken: SLACK_APP_TOKEN }),
  );
}
