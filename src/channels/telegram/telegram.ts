/**
 * Telegram bot channel: verify the webhook secret token → decide via `route(update)` → run the turn → stream the
 * agent's reply back to the chat, ACK 200.
 */
import { join } from "node:path";
import type { ChannelContext, ChannelModule, LongConnectionChannelModule } from "../../channel.ts";
import { log } from "../../log.ts";
import { secretEquals } from "../secret.ts";
import { telegramTurnStream } from "./invoke-turn.ts";
import { type BufferEntry, collectAttachments, createContextBuffer, ownPostEntry } from "./context-buffer.ts";
import {
  type TelegramMessage,
  type TelegramRoute,
  type TelegramUpdate,
  attachmentSummary,
  defaultTelegramRoute,
  extractFiles,
  extractImages,
  fromLabel,
  messageText,
  ownFiles,
  ownImages,
  pickMessage,
  telegramEnvelope,
  telegramPlaceKey,
  telegramStop,
} from "./parse.ts";
import { registerTelegramTransport } from "./shared-api.ts";
import { type TelegramFailure, defaultErrorMessage, deliverTelegramAnswer, telegramReply } from "./preview.ts";
import { attachmentsDir } from "../kit/text.ts";
import { createJsonWebhookRoute } from "../kit/ingress.ts";
import { type Target, callApi, sendMessage } from "./telegram-api.ts";
import { createAskLog, readStart } from "../kit/history.ts";
import { foldBudget } from "../kit/fold-budget.ts";
import { createMessageOwners, createSeenRing, isSenderConversation, senderConversation } from "../kit/state.ts";
import { PRIVACY_MODE_EFFECT, PRIVACY_MODE_FIX } from "./privacy.ts";
import { DROPPED_TURN_NOTICE, NO_ACK, SHARED_ANSWER_NOTICE, createTurnRunner, dispatchStop } from "../kit/turn.ts";
import { type TurnRecordBase, createTurnStore } from "../kit/turn-store.ts";
import { acknowledgeTelegramAsk } from "./reaction.ts";
import { discussionBlock } from "../kit/context-buffer.ts";
import { joinPromise } from "../../promise-bridge.ts";
import { pollTelegramUpdates } from "./polling.ts";

interface StoredTurn extends TurnRecordBase {
  placeKey: string;
  baseText: string;
  chatId: number | string;
  threadId?: number;
  replyTo?: number;
  askedIn?: { chatId: number | string; messageId: number };
  imageFileIds: string[];
  fileIds: string[];
}

function isStoredTurn(t: unknown): t is StoredTurn {
  const r = t as StoredTurn;
  const strings = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === "string");
  return (
    typeof r?.id === "string" &&
    typeof r.conversation === "string" &&
    typeof r.placeKey === "string" &&
    typeof r.baseText === "string" &&
    (typeof r.chatId === "string" || typeof r.chatId === "number") &&
    (r.threadId === undefined || typeof r.threadId === "number") &&
    (r.replyTo === undefined || typeof r.replyTo === "number") &&
    (r.askedIn === undefined ||
      (typeof r.askedIn?.messageId === "number" &&
        (typeof r.askedIn.chatId === "string" || typeof r.askedIn.chatId === "number"))) &&
    strings(r.imageFileIds) &&
    strings(r.fileIds) &&
    typeof r.attempts === "number"
  );
}

// Re-export the public surface authored elsewhere, so `@fastagent-sh/fastagent/telegram` keeps one entry point.
export { defaultTelegramRoute, telegramEnvelope, telegramStop };
export type { TelegramFailure, TelegramMessage, TelegramRoute, TelegramUpdate };

const TELEGRAM_API = "https://api.telegram.org";

/** Update body cap — Telegram updates are small JSON; 1 MiB is generous and guards a public endpoint. */
const MAX_UPDATE_BYTES = 1 << 20;

/** One accepted turn: everything the runner needs to execute it. */
type PendingTurn = Omit<StoredTurn, "attempts">;

export interface TelegramChannelOptions {
  /** Webhook secret token (the `secret_token` you set via setWebhook); verifies inbound updates. */
  secretToken: string;
  /** Bot token — used to send the agent's reply via the Bot API. */
  botToken: string;
  /** Policy: whether/where to answer an update (return null to ignore). */
  route?: (update: TelegramUpdate) => TelegramRoute | null;
  /** Customer-facing failure text for the chat (the dev-facing full `details` always go to the operator log). */
  onError?: (failed: TelegramFailure) => string | undefined;
  /** Bot @username for group @mention summon by the default route (else resolved via getMe). */
  botUsername?: string;
  /** Bot API base, for tests. */
  apiBaseUrl?: string;
}

/** What both ways of receiving hand an update to: the part of a channel that is the same whichever way it arrives. */
interface TelegramRuntime {
  /**
   * Decide, persist and start the turn for one update. Synchronous and durable before it returns (the turn's intent is
   * on disk), so the transport may acknowledge the update the moment it does; a throw means it was not accepted.
   */
  accept(update: TelegramUpdate): void;
  /** Resolves once the turns accepted so far have ended: the test/observability seam. */
  turnsIdle(): Promise<void>;
}

/** What a channel that polls is given: the webhook one's options without the secret that verifies a webhook. */
export type TelegramPollingChannelOptions = Omit<TelegramChannelOptions, "secretToken">;

type TelegramRuntimeOptions = TelegramPollingChannelOptions & { apiBaseUrl: string };

/** The channel's state and policy, over the context it is mounted in: everything but how updates arrive. */
function createTelegramRuntime(
  { botToken, route, onError, botUsername, apiBaseUrl }: TelegramRuntimeOptions,
  { agent, sessionFor, recordedSession, stateDir: stateHome }: ChannelContext,
): TelegramRuntime {
  // Validate at activation so deploy may inspect the module shape before secrets are provisioned.
  if (!botToken) {
    throw new Error("telegramChannel requires a non-empty botToken (used to send the agent's reply)");
  }
  const formatError = onError ?? defaultErrorMessage;
  // One getMe at startup: the bot's @username (for the default route's group @mention summon and for recognising an
  // addressed `/stop`, only when not supplied) and the group-privacy flag — privacy mode off is required to receive
  // the un-summoned group messages that feed the context buffer, so warn if it is on.
  let mentionName = botUsername;
  void callApi(apiBaseUrl, botToken, "getMe", {}).then(
    (me) => {
      if (mentionName === undefined) mentionName = me.username;
      if (me.can_read_all_group_messages === false) {
        log.warn(`[telegram] ${PRIVACY_MODE_EFFECT}. To change that, ${PRIVACY_MODE_FIX}.`);
      }
    },
    // Name every capability the missing username costs, so "the bot ignores /stop@name" is diagnosable from this
    // ONE line.
    (e) =>
      log.warn(
        `[telegram] getMe failed; @mention summon, addressed /stop, and the privacy check are skipped: ${String(e)}`,
      ),
  );
  // A bot token is "<bot_id>:<secret>" — the bot's own id is knowable synchronously, so reply-to-bot targeting is
  // precise from the first update (no getMe race; getMe only resolves the @username).
  const tokenId = Number(botToken.split(":")[0]);
  const botId = Number.isSafeInteger(tokenId) && tokenId > 0 ? tokenId : undefined;
  if (botId === undefined) {
    log.warn("[telegram] bot token has no parseable bot id — reply-to-bot summon disabled until getMe resolves");
  }
  const decide =
    route ?? ((update: TelegramUpdate) => defaultTelegramRoute(update, { botUsername: mentionName, botId }));

  const buffer = createContextBuffer(join(stateHome, "buffers"));
  // Whose a message is, so a reply to it reaches that conversation's session. A message id counts within its chat.
  const owners = createMessageOwners({ label: "[telegram]", path: join(stateHome, "owners.json") });
  const ownerKey = (chatId: number | string, messageId: number): string => `${chatId}:${messageId}`;
  // Where each conversation's session read to: a turn folds the buffer from the ask its session was last sent.
  const asks = createAskLog<number>({
    label: "[telegram]",
    path: join(stateHome, "asks.json"),
    messages: agent.messages,
    isPosition: (value): value is number => typeof value === "number",
    compare: (a, b) => a - b,
  });
  // The send tool rides this channel's token, and what it sends lands in this buffer (shared-api.ts says why).
  registerTelegramTransport({
    apiBaseUrl,
    botToken,
    record: (placeKey, entry) => buffer.push(placeKey, entry),
  });
  // Durable turn intent (L1): persist an accepted turn pre-ACK, remove it when the turn ends; a crash leaves it for
  // replay on the next start.
  const store = createTurnStore<StoredTurn>(join(stateHome, "turns.json"), {
    label: "[telegram]",
    isRecord: isStoredTurn,
    order: (a, b) => Number(a.id) - Number(b.id),
  });
  const targetOf = (r: PendingTurn): Target => ({ chatId: r.chatId, threadId: r.threadId, replyTo: r.replyTo });

  // Tell the asker when a turn is dropped at the execution ceiling: the chain's end needs a signal, not just an
  // operator log line.
  const notifyDropped = (r: PendingTurn): void => {
    void sendMessage(apiBaseUrl, botToken, targetOf(r), DROPPED_TURN_NOTICE, { html: false }).catch((e) =>
      log.warn(`[telegram] could not notify a dropped turn (conversation=${r.conversation}): ${String(e)}`),
    );
  };

  // A message id counts only within its chat, and a custom route can send several chats to one conversation: asks are
  // kept per conversation and place, so a position is only ever compared with another of the same chat.
  const askedBy = (rec: PendingTurn): string => `${rec.conversation}@${rec.placeKey}`;
  /** The newest message id of each place the channel has taken (a summons, or discussion it buffered). */
  const newestTaken = new Map<string, number>();
  /** Messages the agent posted for a sender's session, so a reply to one reaches it (a group's main timeline only). */
  const recordOwned = (rec: PendingTurn, messageIds: number[]): void => {
    if (!isSenderConversation(telegramPlaceKey(rec.chatId, rec.threadId), rec.conversation)) return;
    for (const id of messageIds) owners.record(ownerKey(rec.chatId, id), { conversation: rec.conversation });
  };
  /**
   * An answer a sender's session holds, put where the chat's other senders' reads find it: Telegram never echoes a bot
   * its own messages, so without this Bob's session would not know what Alice was told. Only in a group's main timeline
   * (a topic and a private chat have one session, which holds it), and never at the cost of the answer: it is already
   * in the chat, so a failed write is said and the turn goes on.
   */
  const recordAnswer = (rec: PendingTurn, messageIds: number[], text: string): void => {
    const place = telegramPlaceKey(rec.chatId, rec.threadId);
    const [messageId] = messageIds;
    if (messageId === undefined || !isSenderConversation(place, rec.conversation)) return;
    recordOwned(rec, messageIds);
    // An answer is a preview that is edited into its text, so its message id is from when the answer began. Anyone
    // asked in the chat since has not read it, and their read starts strictly after their own ask: it stands at the
    // newest message of this chat the channel has taken, and sorts after it.
    const at = Math.max(messageId, newestTaken.get(place) ?? 0);
    try {
      buffer.push(place, ownPostEntry(text, messageId, rec.conversation, at));
    } catch (error) {
      log.warn(`[telegram] an answer was not recorded into place ${place}: ${String(error)}`);
    }
  };
  const runner = createTurnRunner<StoredTurn, BufferEntry>({
    label: "[telegram]",
    store,
    discussion: async (rec) => {
      const until = rec.askedIn?.messageId;
      if (until === undefined) return { text: "", folded: [] };
      const start = await readStart(asks, "[telegram]", askedBy(rec), recordedSession(rec.conversation), until);
      const fold = buffer.fold(rec.placeKey, {
        ...(start.after === undefined ? {} : { after: start.after }),
        until,
        budget: await foldBudget(agent, recordedSession(rec.conversation)),
        // What this conversation's own turns answered is in its session; other senders' answers are discussion.
        skip: (entry) => entry.conversation === rec.conversation,
      });
      return start.unreadable === undefined ? fold : { ...fold, text: `${start.unreadable}\n${fold.text}`.trimEnd() };
    },
    delivered: createSeenRing(join(stateHome, "delivered.json"), "[telegram]"),
    where: (rec) => `chat=${rec.chatId}${rec.threadId !== undefined ? ` thread=${rec.threadId}` : ""}`,
    notifyDropped,
    acknowledgeHeld: async (rec) =>
      rec.askedIn === undefined ? NO_ACK : acknowledgeTelegramAsk(apiBaseUrl, botToken, rec.askedIn),
    // A group's answer quotes the first asker's message, so a later asker is told where theirs is.
    notifyShared: async (rec) => {
      if (rec.replyTo === undefined) return;
      await sendMessage(apiBaseUrl, botToken, targetOf(rec), SHARED_ANSWER_NOTICE, { html: false });
    },
    deliverAnswer: (rec, answer) =>
      joinPromise(async () => {
        recordAnswer(rec, await deliverTelegramAnswer(apiBaseUrl, botToken, targetOf(rec), answer), answer);
      }),
    execute: (rec, discussion, onAnswered, turn) =>
      turn.reply(
        telegramTurnStream(
          agent,
          {
            session: () => sessionFor(rec.conversation),
            key: rec.id,
            text: `${discussionBlock(discussion.text)}${rec.baseText}`,
            steer: turn,
          },
          { api: apiBaseUrl, botToken, chatId: rec.chatId, filesDir: attachmentsDir(stateHome) },
          {
            primary: { imageFileIds: rec.imageFileIds, fileIds: rec.fileIds },
            buffered: collectAttachments(discussion.folded, {
              files: new Set(rec.fileIds),
              images: new Set(rec.imageFileIds),
            }),
          },
        ),
        (events) =>
          telegramReply(
            events,
            apiBaseUrl,
            botToken,
            targetOf(rec),
            formatError,
            onAnswered,
            (ids, text) => recordAnswer(rec, ids, text),
            // A correction is as likely a reply to the preview a run is working under as to its answer.
            (id) => recordOwned(rec, [id]),
          ),
      ),
  });

  runner.recover();

  const accept = (update: TelegramUpdate): void => {
    // Decide whether/where to answer, then run the turn.
    const m = pickMessage(update);
    if (!m) return;
    const placeKey = telegramPlaceKey(m.chat.id, m.message_thread_id);
    newestTaken.set(placeKey, Math.max(newestTaken.get(placeKey) ?? 0, m.message_id));
    const r = decide(update);
    if (!r) {
      // Not summoned: in a group, record the message so a later summon has the discussion (needs privacy off to be
      // delivered here at all).
      const isGroup = m.chat.type === "group" || m.chat.type === "supergroup";
      const content = messageText(m);
      if (isGroup && content) {
        // OWN attachments only: each message is its own buffer entry, so a reply's referenced attachment is already
        // (or will be) the other entry's.
        const fileIds = ownFiles(m);
        const imageIds = ownImages(m);
        // A captioned attachment renders as its caption.
        const summary = attachmentSummary(m);
        const bodyLine = summary && content !== summary ? `${content} ${summary}` : content;
        buffer.push(placeKey, {
          sender: fromLabel(m.from) ?? "someone",
          body: bodyLine,
          messageId: m.message_id,
          date: m.date === undefined ? Date.now() : m.date * 1000,
          replyTo: m.reply_to_message?.message_id,
          fileIds: fileIds.length ? fileIds : undefined,
          imageIds: imageIds.length ? imageIds : undefined,
        });
      }
      return;
    }
    // A group's main timeline is one conversation per sender; a forum topic and a private chat are one per place.
    const isGroup = m.chat.type === "group" || m.chat.type === "supergroup";
    const mainTimeline = isGroup && m.message_thread_id === undefined;
    const own = mainTimeline ? senderConversation(placeKey, m.from?.id) : placeKey;
    // A reply to a message the table gives to a session belongs to that session, whoever replies.
    const named =
      mainTimeline && m.reply_to_message
        ? owners.ownerOf(ownerKey(m.chat.id, m.reply_to_message.message_id))?.conversation
        : undefined;
    const conversation = r.conversation ?? named ?? own;
    const chatId = r.chatId ?? m.chat.id;
    // Reply to the summoning message in groups (threads the answer under the asker); a 1:1 DM needs no reply-quote.
    const threadId = r.threadId ?? m.message_thread_id;
    const sameTarget = String(chatId) === String(m.chat.id) && threadId === m.message_thread_id;
    const replyTo = m.chat.type !== "private" && sameTarget ? m.message_id : undefined;
    // Explicit user stop (`/stop`): a control action, never a turn — it must not queue behind the run it stops.
    // `abort` waits until what it stopped has ended, so the update is acknowledged first.
    if (telegramStop(update, { botUsername: mentionName, botId })) {
      runner.track(
        dispatchStop(agent, recordedSession(r.conversation ?? own), "[telegram]")
          .then((feedback) =>
            sendMessage(apiBaseUrl, botToken, { chatId, threadId, replyTo }, feedback, { html: false }),
          )
          .catch((e) => log.warn(`[telegram] stop feedback failed: ${String(e)}`)),
      );
      return;
    }
    const baseText = r.text ?? telegramEnvelope(m);
    const imageFileIds = extractImages(m);
    const fileIds = extractFiles(m);
    if (baseText.trim() !== "" || imageFileIds.length > 0 || fileIds.length > 0) {
      asks.record(`${conversation}@${placeKey}`, { key: `${update.update_id}`, at: m.message_id });
      if (isSenderConversation(placeKey, conversation))
        owners.record(ownerKey(m.chat.id, m.message_id), { conversation });
      // Everything the turn needs, as a plain record; persisted pre-ACK then run serially per session.
      runner.submit(
        {
          id: `${update.update_id}`,
          conversation,
          placeKey,
          baseText,
          chatId,
          threadId,
          replyTo,
          askedIn: { chatId: m.chat.id, messageId: m.message_id },
          imageFileIds,
          fileIds,
        },
        true,
      );
    }
    return;
  };
  return { accept, turnsIdle: runner.idle };
}

/** Build a Telegram bot channel that receives by webhook: policy options in, a {@link ChannelModule} out. */
export function telegramChannel(options: TelegramChannelOptions): ChannelModule {
  const { secretToken, apiBaseUrl = TELEGRAM_API } = options;
  return (ctx) => {
    if (!secretToken) {
      throw new Error(
        "telegramChannel requires a non-empty secretToken (the webhook secret_token; an unset one accepts forged updates)",
      );
    }
    const runtime = createTelegramRuntime({ ...options, apiBaseUrl }, ctx);
    const handler = createJsonWebhookRoute<TelegramUpdate>({
      maxBytes: MAX_UPDATE_BYTES,
      turnsIdle: runtime.turnsIdle,
      beforeBody: (req) =>
        secretEquals(req.headers.get("x-telegram-bot-api-secret-token"), secretToken)
          ? undefined
          : new Response("invalid secret token\n", { status: 401 }),
      handle: (_req, _raw, update) => {
        runtime.accept(update);
        return new Response(null, { status: 200 });
      },
    });
    return { "POST /telegram": handler };
  };
}

/**
 * Build a Telegram bot channel that receives by long polling: the process asks Telegram for updates, so no public URL
 * and no webhook secret are involved. It takes the webhook away from the bot first (`getUpdates` does not work while
 * one is set), so a bot is polled by one process or reached by one webhook, never both.
 */
export function telegramPollingChannel(options: TelegramPollingChannelOptions): LongConnectionChannelModule {
  const apiBaseUrl = options.apiBaseUrl ?? TELEGRAM_API;
  return {
    name: "telegram long polling",
    connect(ctx, signal) {
      const runtime = createTelegramRuntime({ ...options, apiBaseUrl }, ctx);
      return pollTelegramUpdates({ apiBaseUrl, botToken: options.botToken, accept: runtime.accept }, signal);
    },
  };
}
