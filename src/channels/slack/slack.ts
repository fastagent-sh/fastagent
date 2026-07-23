/** First-party Slack HTTP Events API channel: signed ingress, durable turns/context, files, and edited previews. */
import { createHmac, timingSafeEqual } from "node:crypto";
import { isAbsolute, join } from "node:path";
import type { ChannelModule } from "../../host/node.ts";
import { log } from "../../log.ts";
import { readBodyCapped } from "../body.ts";
import { text } from "../respond.ts";
import { createSeenRing } from "../seen.ts";
import { ensureStateHome } from "../state.ts";
import { dispatchStop, isStopText } from "../stop-command.ts";
import { codePointPrefix } from "../text.ts";
import { createTurnQueue } from "../turn-queue.ts";
import { createTurnStore } from "../turn-store.ts";
import { createSlackBotTokenProvider } from "./bot-auth.ts";
import { collectSlackBufferedFiles, createSlackContextBuffer } from "./context-buffer.ts";
import { invokeSlackTurn } from "./invoke-turn.ts";
import { createOwnedSlackThreads } from "./owned-threads.ts";
import {
  type SlackEventEnvelope,
  type SlackFile,
  type SlackMessageEvent,
  type SlackRoute,
  defaultSlackRoute,
  isSlackDirectMessage,
  isSlackGroupMessage,
  isSlackHumanMessage,
  slackBufferText,
  slackEnvelope,
  slackFileIds,
  slackMessageText,
  slackPlaceKey,
  slackSenderLabel,
  slackTeamId,
} from "./parse.ts";
import {
  type SlackFailure,
  type SlackRendering,
  defaultErrorMessage,
  settleSlackPreview,
  streamSlackReply,
} from "./preview.ts";
import { resolveReactionEmojis, startSlackReaction } from "./reaction.ts";
import { type SlackTarget, type SlackTaskDisplayMode, createSlackApi } from "./slack-api.ts";
import { createWelcomedUsers } from "./welcomed.ts";

export { defaultSlackRoute, slackEnvelope };
export type { SlackEventEnvelope, SlackFailure, SlackFile, SlackMessageEvent, SlackRendering, SlackRoute };

const MAX_EVENT_BYTES = 1 << 20;
const MAX_TURN_ATTEMPTS = 3;
const MAX_SIGNATURE_AGE_S = 5 * 60;
const QUEUED_PLACEHOLDER = "⏳ Queued — I’ll start once the current task finishes.";
const DEFERRED_PLACEHOLDER = "⏳ Delayed by a temporary system issue — I’ll retry automatically.";
const DEFAULT_WELCOME = "👋 Hi! I'm an AI agent here to help. Ask a question or describe a task and I'll get to work.";

interface StoredSlackTurn {
  id: string;
  seq: number;
  session: string;
  baseText: string;
  bufferKey: string;
  teamId: string;
  channelId: string;
  threadTs?: string;
  requesterUserId?: string;
  threadTitle?: string;
  fileIds: string[];
  attempts: number;
}

function isStoredSlackTurn(value: unknown): value is StoredSlackTurn {
  const turn = value as StoredSlackTurn;
  return (
    typeof turn?.id === "string" &&
    typeof turn.seq === "number" &&
    typeof turn.session === "string" &&
    typeof turn.baseText === "string" &&
    typeof turn.bufferKey === "string" &&
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

interface PendingSlackTurn extends Omit<StoredSlackTurn, "attempts"> {
  previewTs?: string;
  nativeQueueStatus?: boolean;
}

export interface SlackChannelOptions {
  /** Bot User OAuth Token (`xoxb-…`) used for replies and files. */
  botToken: string;
  /** App signing secret used to verify the raw Events API request body. */
  signingSecret: string;
  /** Rotating OAuth credentials. Omit all four only for a manually managed long-lived bot token. */
  botRefreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  botTokenExpiresAt?: number;
  /** Direct-message policy. `threaded` (default) gives every top-level DM its own session/thread;
   * `continuous` keeps one linear session per DM channel. */
  directMessageSession?: "continuous" | "threaded";
  /** Group-message context + delivery policy. `threaded` (default) gives every top-level summon its
   * own session/thread; `continuous` keeps one session for channel-top-level turns while preserving
   * existing Slack threads as separate root sessions. */
  groupMessageSession?: "continuous" | "threaded";
  /** `context` (default) admits bare replies in managed group threads and buffers unsummoned group
   * discussion. `mentions` answers only app_mention plus DMs for an explicit least-privilege setup. */
  groupBehavior?: "context" | "mentions";
  /** `native` (default) uses Slack Agent streams/tasks for threaded replies. `classic` retains the
   * compatibility renderer based on one rate-limited edited message. A top-level target selected by an
   * explicit continuous/custom policy necessarily uses the classic renderer because Slack streams
   * require a parent user message. */
  rendering?: SlackRendering;
  /** Native task-card layout (`chat.startStream` `task_display_mode`): `plan` (default) groups steps
   * under a single collapsible heading, `timeline` lists each step sequentially, `dense` collapses
   * consecutive tool calls into one summarized card. Applies to the native renderer only. */
  taskDisplay?: SlackTaskDisplayMode;
  /** Optional footer for successful Agent replies. Omitted or `false` sends no repetitive disclaimer. */
  aiDisclaimer?: string | false;
  /** First-run direct-message welcome, sent once when a user first opens the DM (`app_home_opened`,
   * `tab: "messages"`). A string customizes it; `false` disables it. Plain Markdown only — no interactive
   * buttons until an interactivity endpoint exists. Defaults to a generic greeting. */
  welcome?: string | false;
  /** Lightweight emoji ack on the user's triggering message: 👀 while working, ✅ when done. `false`
   * disables it; an object overrides either emoji name. Requires the `reactions:write` scope; a missing
   * scope degrades to no ack. */
  reactionAck?: false | { processing?: string; completed?: string };
  /** Custom route policy. Providing it disables the default managed-thread/context admission policy. */
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
  if (!/^\d+$/.test(timestamp) || !/^v0=[a-f0-9]{64}$/i.test(signature)) return false;
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds) || Math.abs(Math.floor(nowMs / 1000) - seconds) > MAX_SIGNATURE_AGE_S)
    return false;
  const expected = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

/** The (channel, ts) of the user's triggering message, encoded in the logical turn id `team:channel:ts`
 *  (Slack ids never contain a colon, so a 3-part split is exact). Used to place the reaction ack. */
function messageRefOf(turnId: string): { channelId: string; ts: string } | undefined {
  const parts = turnId.split(":");
  return parts.length === 3 && parts[1] && parts[2] ? { channelId: parts[1], ts: parts[2] } : undefined;
}

export function slackChannel({
  botToken,
  signingSecret,
  botRefreshToken,
  clientId,
  clientSecret,
  botTokenExpiresAt,
  directMessageSession = "threaded",
  groupMessageSession = "threaded",
  groupBehavior = "context",
  rendering = "native",
  taskDisplay = "plan",
  aiDisclaimer,
  welcome = DEFAULT_WELCOME,
  reactionAck = {},
  route,
  onError,
  apiBaseUrl = "https://slack.com/api",
}: SlackChannelOptions): ChannelModule {
  if (!(["continuous", "threaded"] as const).includes(directMessageSession)) {
    throw new Error('slackChannel directMessageSession must be "continuous" or "threaded"');
  }
  if (!(["continuous", "threaded"] as const).includes(groupMessageSession)) {
    throw new Error('slackChannel groupMessageSession must be "continuous" or "threaded"');
  }
  if (!(["context", "mentions"] as const).includes(groupBehavior)) {
    throw new Error('slackChannel groupBehavior must be "context" or "mentions"');
  }
  if (!(["native", "classic"] as const).includes(rendering)) {
    throw new Error('slackChannel rendering must be "native" or "classic"');
  }
  if (!(["timeline", "plan", "dense"] as const).includes(taskDisplay)) {
    throw new Error('slackChannel taskDisplay must be "timeline", "plan", or "dense"');
  }
  if (welcome !== false && typeof welcome !== "string") {
    throw new Error("slackChannel welcome must be a string or false");
  }
  const reactionEmojis = resolveReactionEmojis(reactionAck);

  return ({ agent, stateRoot, control }) => {
    if (!botToken) throw new Error("slackChannel requires a non-empty botToken (Bot User OAuth Token)");
    if (!signingSecret)
      throw new Error("slackChannel requires a non-empty signingSecret (Basic Information → App Credentials)");
    if (!isAbsolute(stateRoot)) throw new Error(`slackChannel requires an absolute ctx.stateRoot, got "${stateRoot}"`);

    const label = "[slack]";
    const formatError = onError ?? defaultErrorMessage;
    const stateHome = join(stateRoot, "channels", "slack");
    ensureStateHome(stateHome);
    const currentBotToken = createSlackBotTokenProvider({
      statePath: join(stateHome, "bot-auth.json"),
      botToken,
      botRefreshToken,
      clientId,
      clientSecret,
      botTokenExpiresAt,
      apiBaseUrl,
    });
    const api = createSlackApi({ botToken: currentBotToken, baseUrl: apiBaseUrl });
    let authenticatedTeamId: string | undefined;
    let botUserId: string | undefined;
    let authenticationState: "pending" | "ready" | "failed" = "pending";
    const authentication = api.authTest().then(
      (identity) => {
        authenticatedTeamId = identity.teamId;
        botUserId = identity.userId;
        authenticationState = "ready";
        log.info(`${label} authenticated${identity.teamId ? ` for workspace ${identity.teamId}` : ""}`);
      },
      (error) => {
        authenticationState = "failed";
        throw new Error(`Slack auth.test failed — fix SLACK_BOT_TOKEN before accepting events: ${String(error)}`, {
          cause: error,
        });
      },
    );
    // Construction cannot await Web API IO. Keep the rejection observed; recovered turns and ingress
    // both gate on the same promise/state below and surface the failure without ACKing new work.
    void authentication.catch((error) => log.error(`${label} ${String(error)}`));
    const waitForAuthentication = (): Promise<void> => {
      if (authenticationState !== "pending") return authentication;
      return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Slack auth.test did not finish inside the Events API ACK budget")),
          2_000,
        );
        void authentication.then(
          () => {
            clearTimeout(timeout);
            resolve();
          },
          (error) => {
            clearTimeout(timeout);
            reject(error);
          },
        );
      });
    };

    const seen = createSeenRing(join(stateHome, "seen.json"), label);
    const ownedThreads = createOwnedSlackThreads(join(stateHome, "owned-threads.json"), label);
    const welcomed = createWelcomedUsers(join(stateHome, "welcomed.json"), label);
    const buffer = createSlackContextBuffer(join(stateHome, "buffers.json"), label);
    const store = createTurnStore<StoredSlackTurn>(join(stateHome, "turns.json"), {
      label,
      isRecord: isStoredSlackTurn,
      order: (a, b) => a.seq - b.seq,
    });
    const decide = route ?? defaultSlackRoute;
    const toStored = (turn: PendingSlackTurn): StoredSlackTurn => {
      const { previewTs: _preview, nativeQueueStatus: _status, ...intent } = turn;
      return { ...intent, attempts: 0 };
    };
    const targetOf = (turn: PendingSlackTurn): SlackTarget => ({
      channelId: turn.channelId,
      threadTs: turn.threadTs,
      recipientUserId: turn.requesterUserId,
      recipientTeamId: turn.teamId,
    });

    const notices = new Map<string, Promise<void>>();
    const queue = createTurnQueue<PendingSlackTurn>({
      label,
      onQueuedBehind(turn) {
        const nativeDmStatus = rendering === "native" && turn.threadTs && turn.channelId.startsWith("D");
        if (nativeDmStatus) turn.nativeQueueStatus = true;
        notices.set(
          turn.id,
          authentication
            .then(() =>
              nativeDmStatus
                ? api.setThreadStatus(targetOf(turn), "is queued behind an earlier request…")
                : api.postMessage(targetOf(turn), QUEUED_PLACEHOLDER).then((ts) => {
                    turn.previewTs = ts;
                  }),
            )
            .catch((error) => log.warn(`${label} queue preview failed (the turn stays durable): ${String(error)}`)),
        );
      },
      run: async (turn) => {
        await notices.get(turn.id);
        notices.delete(turn.id);
        try {
          await authentication;
        } catch (error) {
          // Leave the intent untouched. A fixed token + restart replays it; running now would execute an
          // Agent turn whose only customer-facing transport is known to be unavailable.
          log.error(`${label} deferring durable turn ${turn.id} because Slack authentication failed: ${String(error)}`);
          return;
        }
        const attempt = store.startAttempt(turn.id, MAX_TURN_ATTEMPTS);
        if (attempt === "exceeded") {
          notifyDropped(turn);
          return;
        }
        if (attempt === "defer") {
          if (turn.nativeQueueStatus) {
            void api
              .setThreadStatus(targetOf(turn), "is delayed by a temporary system issue and will retry after restart…")
              .catch((error) => log.warn(`${label} could not update a deferred Agent status: ${String(error)}`));
          } else if (turn.previewTs) {
            void settleSlackPreview(api, targetOf(turn), turn.previewTs, DEFERRED_PLACEHOLDER).catch((error) =>
              log.warn(`${label} could not update a deferred queue preview: ${String(error)}`),
            );
          }
          return;
        }

        const startedAt = Date.now();
        log.info(`${label} turn start: turn=${turn.id} session=${turn.session} channel=${turn.channelId}`);
        const { text: recent, consumed } = buffer.peek(turn.bufferKey);
        const prompt = recent ? `[recent group discussion:\n${recent}\n]\n\n${turn.baseText}` : turn.baseText;
        const buffered = collectSlackBufferedFiles(consumed, new Set(turn.fileIds));
        const messageRef = messageRefOf(turn.id);
        const reaction =
          reactionEmojis && messageRef
            ? await startSlackReaction({
                api,
                channelId: messageRef.channelId,
                ts: messageRef.ts,
                emojis: reactionEmojis,
                label,
              })
            : undefined;
        try {
          await streamSlackReply(
            invokeSlackTurn(
              agent,
              turn.session,
              prompt,
              { api, channelId: turn.channelId, filesDir: join(stateHome, "files"), label },
              { primaryFileIds: turn.fileIds, buffered },
              () => {
                store.remove(turn.id);
                buffer.commit(turn.bufferKey, consumed);
              },
            ),
            api,
            targetOf(turn),
            formatError,
            {
              rendering,
              initialPreviewTs: turn.previewTs,
              threadTitle: turn.threadTitle,
              disclaimer: aiDisclaimer,
              taskDisplay,
              label,
            },
          );
          log.info(`${label} turn done: turn=${turn.id} session=${turn.session} (${Date.now() - startedAt}ms)`);
          await reaction?.complete();
        } catch (error) {
          log.error(`${label} turn failed: turn=${turn.id} session=${turn.session}: ${String(error)}`);
          await reaction?.remove();
        } finally {
          store.remove(turn.id);
        }
      },
    });

    const notifyDropped = (turn: PendingSlackTurn): void => {
      const target = targetOf(turn);
      if (turn.nativeQueueStatus) void api.setThreadStatus(target, "").catch(() => {});
      void settleSlackPreview(
        api,
        target,
        turn.previewTs,
        "⚠️ I couldn’t complete an earlier request — please ask again.",
      ).catch((error) => log.warn(`${label} could not notify a dropped turn: ${String(error)}`));
    };

    const submit = (turn: PendingSlackTurn, persist: boolean): void => {
      if (persist) {
        store.add(toStored(turn));
        seen.add(turn.id);
      }
      queue.accept(turn);
    };

    const recovered = store.recover();
    if (recovered.length) log.info(`${label} recovering ${recovered.length} unfinished turn(s) from a prior run`);
    let seq = recovered.reduce((maximum, turn) => Math.max(maximum, turn.seq), 0);
    for (const { attempts: _attempts, ...intent } of recovered) submit({ ...intent }, false);

    const acceptEvent = (envelope: SlackEventEnvelope): void => {
      const event = envelope.event;
      if (!isSlackHumanMessage(event)) return;
      if (botUserId && event.user === botUserId) return;
      const teamId = slackTeamId(envelope) ?? authenticatedTeamId;
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
      const bufferKey = slackPlaceKey(teamId, event);
      const threadedGroup = group && groupMessageSession === "threaded";
      const managedContinuation =
        groupBehavior === "context" &&
        route === undefined &&
        threadedGroup &&
        event.thread_ts !== undefined &&
        ownedThreads.has(teamId, event.channel, event.thread_ts);

      let routed = decide(envelope);
      const hasUserMention = /<@[A-Z0-9]+>/i.test(event.text ?? "");
      const structurallyMentionsBot = botUserId !== undefined && (event.text ?? "").includes(`<@${botUserId}>`);
      // app_mention and message.* subscriptions can overlap. If message.* arrives first, structural bot
      // identity routes it now; while auth.test is still unresolved, defer any mentioned message rather
      // than buffer+dedup it and accidentally suppress the later app_mention callback.
      if (!routed && route === undefined && group && event.type === "message" && structurallyMentionsBot) routed = {};
      if (!routed && managedContinuation && event.type !== "app_mention") routed = {};
      if (!routed) {
        if (route === undefined && group && botUserId === undefined && hasUserMention) return;
        if (groupBehavior === "context" && route === undefined && group) {
          const body = slackBufferText(slackMessageText(event));
          if (body) {
            const fileIds = slackFileIds(event);
            buffer.push(bufferKey, {
              sender: slackSenderLabel(event),
              body,
              messageId: event.ts,
              replyTo: event.thread_ts,
              fileIds: fileIds.length ? fileIds : undefined,
            });
            seen.add(logicalId);
            log.debug(`${label} buffered unsummoned group message ${logicalId} (place ${bufferKey})`);
          }
        }
        return;
      }

      const targetChannel = routed.channelId ?? event.channel;
      const sameChannel = targetChannel === event.channel;
      const defaultThread = group
        ? (event.thread_ts ?? (groupMessageSession === "threaded" ? event.ts : undefined))
        : (event.thread_ts ?? (directMessageSession === "threaded" ? event.ts : undefined));
      const threadTs =
        routed.threadTs === null ? undefined : (routed.threadTs ?? (sameChannel ? defaultThread : undefined));
      const continuousTopLevel = event.thread_ts === undefined;
      const defaultSession = direct
        ? directMessageSession === "continuous" && continuousTopLevel
          ? `slack:${teamId}:${event.channel}`
          : `slack:${teamId}:${event.channel}:${rootTs}`
        : groupMessageSession === "continuous" && continuousTopLevel
          ? `slack:${teamId}:${event.channel}`
          : `slack:${teamId}:${event.channel}:${rootTs}`;
      // Explicit user stop: a control action, never a turn — it must not queue behind the run it
      // stops. Match the bare word after stripping the bot mention; record the logical id so a Slack
      // redelivery doesn't double-abort or double-notify.
      if (isStopText((event.text ?? "").replace(/<@[A-Z0-9]+>/gi, " "))) {
        seen.add(logicalId);
        const target: SlackTarget = { channelId: event.channel, threadTs: event.thread_ts };
        const stop: Promise<void> = dispatchStop(control, routed.session ?? defaultSession, label)
          .then((feedback) => api.postMessage(target, feedback).then(() => undefined))
          .catch((error) => log.warn(`${label} stop feedback failed: ${String(error)}`))
          .finally(() => {
            stops.delete(stop);
          });
        stops.add(stop);
        return;
      }
      const fileIds = slackFileIds(event);
      const baseText = routed.text ?? slackEnvelope(envelope);
      if (!baseText.trim() && fileIds.length === 0) return;
      const threadTitle =
        direct && event.thread_ts === undefined
          ? codePointPrefix(
              slackMessageText(event)
                .replace(/<@[A-Z0-9]+>/gi, "")
                .replace(/\s+/g, " ")
                .trim(),
              80,
            )
          : undefined;

      // Match Feishu/Lark ownership in context mode: only a top-level summon that creates an
      // Agent-managed thread owns the root. Mentioning the Agent inside an existing human thread
      // answers once without adopting it; mention-only mode never consumes ownership state.
      if (
        groupBehavior === "context" &&
        route === undefined &&
        threadedGroup &&
        event.thread_ts === undefined &&
        sameChannel
      ) {
        ownedThreads.add(teamId, event.channel, rootTs);
      }
      submit(
        {
          id: logicalId,
          seq: ++seq,
          session: routed.session ?? defaultSession,
          baseText,
          bufferKey,
          teamId,
          channelId: targetChannel,
          threadTs,
          requesterUserId: event.user,
          threadTitle: threadTitle || undefined,
          fileIds,
        },
        true,
      );
    };

    const stops = new Set<Promise<void>>();

    // First-run DM welcome: app_home_opened(tab="messages") signals a DM open. Post once per user.
    const welcomeInFlight = new Set<string>();
    const welcomes = new Set<Promise<void>>();
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
      const teamId = slackTeamId(envelope) ?? authenticatedTeamId;
      if (!teamId) return;
      const id = `${teamId}:${userId}`;
      if (welcomed.has(teamId, userId) || welcomeInFlight.has(id)) return;
      // Reserve in-memory so rapid re-opens don't double-post; persist to the durable set only on a
      // successful post, so a failed post simply retries on the next open.
      welcomeInFlight.add(id);
      const promise = api
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
          welcomes.delete(promise);
        });
      welcomes.add(promise);
    };

    const handler = async (request: Request): Promise<Response> => {
      if (request.method !== "POST") return text("POST only\n", 405);
      const body = await readBodyCapped(request, MAX_EVENT_BYTES);
      if ("tooLarge" in body) return text("payload too large\n", 413);
      const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";
      const signature = request.headers.get("x-slack-signature") ?? "";
      if (!verifySlackSignature(signingSecret, timestamp, signature, body.text)) {
        log.warn(`${label} rejected an event with an invalid/stale X-Slack-Signature`);
        return text("invalid signature\n", 401);
      }

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
        await waitForAuthentication();
      } catch (error) {
        log.error(`${label} refusing to ACK an event because Slack authentication is unavailable: ${String(error)}`);
        return text("slack authentication unavailable\n", 503);
      }
      maybeWelcome(envelope);
      acceptEvent(envelope);
      return new Response(null, { status: 200 });
    };
    (handler as typeof handler & { turnsIdle?: () => Promise<void> }).turnsIdle = () =>
      Promise.all([queue.idle(), ...welcomes, ...stops]).then(() => undefined);
    return { "POST /slack": handler };
  };
}
