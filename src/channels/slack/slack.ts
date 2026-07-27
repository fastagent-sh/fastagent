/** First-party Slack HTTP Events API channel: signed ingress, durable turns/context, files, and edited previews. */
import { createHmac, timingSafeEqual } from "node:crypto";
import { isAbsolute, join } from "node:path";
import type { ChannelModule } from "../../host/node.ts";
import { log } from "../../log.ts";
import { readBodyCapped } from "../body.ts";
import { text } from "../respond.ts";
import { createSeenRing } from "../seen.ts";
import { createThreadParticipants } from "../thread-participants.ts";
import { createTaskTracker } from "../tasks.ts";
import { ensureStateHome, removeRetiredStateFile } from "../state.ts";
import { dispatchStop, isStopText } from "../stop-command.ts";
import { codePointPrefix } from "../text.ts";
import { createTurnQueue } from "../turn-queue.ts";
import { createTurnStore } from "../turn-store.ts";
import { createSlackBotTokenProvider } from "./bot-auth.ts";
import { collectSlackBufferedFiles, createSlackContextBuffer } from "./context-buffer.ts";
import { invokeSlackTurn } from "./invoke-turn.ts";
import {
  type SlackEventEnvelope,
  type SlackFile,
  type SlackMessageEvent,
  type SlackRoute,
  defaultSlackRoute,
  isSlackDirectMessage,
  isSlackGroupMessage,
  hasSlackMention,
  hasSlackUserMention,
  isSlackHumanMessage,
  mentionsSlackUser,
  stripSlackMentions,
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
import { type SlackTarget, createSlackApi } from "./slack-api.ts";
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
  /** `context` (default) subscribes to group message streams, which is what lets the channel HEAR a
   * thread: bare replies are then admitted by the participation rule (design/participant-model.md §3),
   * and other discussion is buffered. `mentions` answers only app_mention plus DMs for an explicit
   * least-privilege setup. */
  groupBehavior?: "context" | "mentions";
  /** `native` (default) uses Slack Agent streams for threaded replies. Its inline tool traces carry a
   * bounded summary of each call's first argument and cannot be retracted, so they stay in the
   * delivered message beside the answer. `classic` retains the compatibility renderer based on one
   * rate-limited edited message, which settles into the answer alone. A top-level target necessarily
   * uses the classic renderer, because Slack streams require a parent user message; a custom route
   * reaches one either by returning `threadTs: null` or by redirecting to another channel without
   * naming a thread. */
  rendering?: SlackRendering;
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

export function slackChannel(options: SlackChannelOptions): ChannelModule {
  const {
    botToken,
    signingSecret,
    botRefreshToken,
    clientId,
    clientSecret,
    botTokenExpiresAt,
    groupBehavior = "context",
    rendering = "native",
    aiDisclaimer,
    welcome = DEFAULT_WELCOME,
    reactionAck = {},
    route,
    onError,
    apiBaseUrl = "https://slack.com/api",
  } = options;

  // The participant model derives placement instead of selecting it: Slack has no quote primitive, so
  // answering in place means answering in a thread on the ask, whichever renderer draws it. An
  // upgraded workspace still passing one of the removed modes would otherwise start fine and silently
  // get a different placement AND a different memory boundary.
  const removedModes = ["directMessageSession", "groupMessageSession"].filter(
    (name) => (options as unknown as Record<string, unknown>)[name] !== undefined,
  );
  if (removedModes.length > 0) {
    throw new Error(
      `slackChannel no longer accepts ${removedModes.join(" / ")}: an answer goes in a thread on the ask, and ` +
        "that thread is the session — see docs/design/participant-model.md",
    );
  }
  if (!(["context", "mentions"] as const).includes(groupBehavior)) {
    throw new Error('slackChannel groupBehavior must be "context" or "mentions"');
  }
  if (!(["native", "classic"] as const).includes(rendering)) {
    throw new Error('slackChannel rendering must be "native" or "classic"');
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
    const threadParticipants = createThreadParticipants(join(stateHome, "thread-participants.json"), label);
    /** A thread's participation is keyed by the SESSION it describes — "the agent answered here" is a
     *  claim about a memory, so the two must not be re-keyable independently. What keeps the claim true
     *  under a custom route is the `routed.session === undefined` condition on the write, not the
     *  absence of a route: a route that supplies its own session records nothing here. */
    const threadKey = (teamId: string, channelId: string, threadTs: string): string =>
      `slack:${teamId}:${channelId}:${threadTs}`;
    // The participant model replaced the owned-thread index (a cache, so nothing is lost). REMOVE THIS
    // after the release following the participant model ships — by then no live deployment can still
    // be carrying the file. test/migration-deadline.test.ts fails when due.
    removeRetiredStateFile(stateHome, "owned-threads.json", label);
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

    // Acceptance touches no network, so it stays synchronous inside Slack's ACK window and the
    // delivery dedup ring alone is enough — there is no await for a duplicate delivery to race
    // through. The minutes-long Agent turn remains fire-and-forget.
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
      // Listening is not speaking: every message the channel can see refines who takes part in its
      // thread, whether or not it is answered. Humans only — a bot's own posts are recorded where they
      // are known — this channel answering.
      // Structural facts only, never `groupBehavior` or `route` — see thread-participants.ts. Slack
      // adds no delta of its own here; its summon rule is the only consumer.
      if (group && event.thread_ts !== undefined) {
        threadParticipants.merge(threadKey(teamId, event.channel, event.thread_ts), { humans: [event.user] });
      }

      let routed = decide(envelope);
      // Two different questions (see parse.ts). `addressesSomeone` is the "@-mentions only other people
      // is discussion, never an ask" guard (§3) and counts broadcasts and user groups too;
      // `mightBeTheBot` gates the identity-window deferral below, where only a USER mention qualifies.
      const addressesSomeone = hasSlackMention(event.text ?? "");
      const mightBeTheBot = hasSlackUserMention(event.text ?? "");
      const structurallyMentionsBot = botUserId !== undefined && mentionsSlackUser(event.text ?? "", botUserId);
      // app_mention and message.* subscriptions can overlap. If message.* arrives first, structural bot
      // identity routes it now; while auth.test is still unresolved, defer any mentioned message rather
      // than buffer+dedup it and accidentally suppress the later app_mention callback.
      if (!routed && route === undefined && group && event.type === "message" && structurallyMentionsBot) routed = {};
      // The participant model's thread rule (§3): a bare message reaches the agent while it takes part
      // and has not heard a second human. Note the ORDER — the mention guard below runs first and is
      // structural: it reads who THIS message addresses, which is the one thing an observation-only
      // store cannot know about someone it has never heard.
      if (
        !routed &&
        groupBehavior === "context" &&
        route === undefined &&
        group &&
        event.thread_ts !== undefined &&
        event.type !== "app_mention" &&
        // Mentioning only other people is targeted discussion, never an ask (§3) — the same guard
        // Feishu applies with `hasMentions`.
        !addressesSomeone &&
        threadParticipants.admitsBareMessage(threadKey(teamId, event.channel, event.thread_ts))
      ) {
        routed = {};
      }
      if (!routed) {
        if (route === undefined && group && botUserId === undefined && mightBeTheBot) return;
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
      // Answer where asked (participant model §4). Slack has no quote primitive, so the only way to
      // attach an answer to its question is a thread on it — which then IS the place, and carries the
      // memory (§5). Native streaming additionally REQUIRES a thread, but the shape does not depend on
      // the renderer: `classic` attaches its answer the same way.
      const defaultThread = event.thread_ts ?? event.ts;
      const threadTs =
        routed.threadTs === null ? undefined : (routed.threadTs ?? (sameChannel ? defaultThread : undefined));
      const defaultSession = threadKey(teamId, event.channel, rootTs);
      // Explicit user stop: a control action, never a turn — it must not queue behind the run it
      // stops. Match the bare word after stripping the bot mention; record the logical id so a Slack
      // redelivery doesn't double-abort or double-notify.
      if (isStopText(stripSlackMentions(event.text ?? ""))) {
        seen.add(logicalId);
        const target: SlackTarget = { channelId: event.channel, threadTs: event.thread_ts };
        sideTasks.track(
          dispatchStop(control, routed.session ?? defaultSession, label)
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

      // Answering inside a GROUP thread makes the agent a participant of it, which is what lets the
      // NEXT bare message address it without a mention.
      //
      // `group` excludes DMs, whose `threadTs` is always defined (the answer opens its assistant
      // thread) and which no rule could ever read — safe because it is structural: a channel never
      // becomes a DM.
      //
      // The two `routed` conditions keep the record describing what it claims. `session` undefined: the
      // flag asserts "the agent answered into THIS thread's session", so a route supplying its own
      // would record participation in a memory that never held the turn. `threadTs` undefined: a route
      // can send the answer to a DIFFERENT thread, where the asker never spoke — recording them there
      // would invent a participant. Feishu carries the same two conditions for the same reasons.
      //
      // Recorded only once the intent is durable: `submit` can throw, and a redelivery must still see
      // the thread as the agent has actually left it.
      if (
        group &&
        threadTs !== undefined &&
        sameChannel &&
        routed.session === undefined &&
        routed.threadTs === undefined
      ) {
        // The ASKER counts as heard in this thread too, and both halves are written together so the
        // record can never say "the agent takes part and nobody has spoken". When the ask is top
        // level, the answer is what CREATES the thread, so the observation above never ran for it (no
        // `thread_ts` on the ask) — without this, a thread whose root is a human would not count them,
        // and a stranger's first bare reply would read as a two-party exchange. `event.user` is
        // guaranteed here (isSlackHumanMessage). Idempotent when the ask was already in the thread.
        threadParticipants.merge(threadKey(teamId, event.channel, threadTs), {
          agentSpoke: true,
          humans: [event.user],
        });
      }
    };

    // Side tasks (stop feedback, DM welcomes) run off the ACK path but drain in turnsIdle.
    const sideTasks = createTaskTracker();

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
      const teamId = slackTeamId(envelope) ?? authenticatedTeamId;
      if (!teamId) return;
      const id = `${teamId}:${userId}`;
      if (welcomed.has(teamId, userId) || welcomeInFlight.has(id)) return;
      // Reserve in-memory so rapid re-opens don't double-post; persist to the durable set only on a
      // successful post, so a failed post simply retries on the next open.
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
      Promise.all([queue.idle(), sideTasks.drain()]).then(() => undefined);
    return { "POST /slack": handler };
  };
}
