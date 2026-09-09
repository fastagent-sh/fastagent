/**
 * Telegram bot channel: verify the webhook secret token → decide via `route(update)` → run the turn → stream the
 * agent's reply back to the chat, ACK 200.
 */
import { isAbsolute, join } from "node:path";
import type { ChannelModule } from "../../channel.ts";
import { log } from "../../log.ts";
import { readBodyCapped } from "../body.ts";
import { text } from "../respond.ts";
import { secretEquals } from "../secret.ts";
import { telegramTurnStream } from "./invoke-turn.ts";
import { type BufferEntry, collectAttachments, createContextBuffer } from "./context-buffer.ts";
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
  telegramStop,
} from "./parse.ts";
import { type TelegramFailure, defaultErrorMessage, telegramReply } from "./preview.ts";
import { ensureStateHome } from "../kit/state.ts";
import { dispatchStop } from "../kit/stop-command.ts";
import { type Target, callApi, editMessageText, sendMessage } from "./telegram-api.ts";
import { createTurnRunner } from "../kit/turn-runner.ts";
import { discussionBlock } from "../kit/context-buffer.ts";
import { type StoredTurn, createTurnStore } from "./turn-store.ts";

// Re-export the public surface authored elsewhere, so `@fastagent-sh/fastagent/telegram` keeps one entry point.
export { defaultTelegramRoute, telegramEnvelope, telegramStop };
export type { TelegramFailure, TelegramMessage, TelegramRoute, TelegramUpdate };

/** Update body cap — Telegram updates are small JSON; 1 MiB is generous and guards a public endpoint. */
const MAX_UPDATE_BYTES = 1 << 20;

/** One accepted turn: everything the runner needs to execute it. */
interface PendingTurn extends Omit<StoredTurn, "attempts"> {
  /** The "⏳ queued" notice's message_id, when one was sent — the turn's preview takes it over. */
  previewId?: number;
}

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

/** Build a Telegram bot channel: policy options in, a {@link ChannelModule} out. */
export function telegramChannel({
  secretToken,
  botToken,
  route,
  onError,
  botUsername,
  apiBaseUrl = "https://api.telegram.org",
}: TelegramChannelOptions): ChannelModule {
  return ({ agent, stateRoot, control }) => {
    // Validate at activation so deploy may inspect the module shape before secrets are provisioned.
    if (!secretToken) {
      throw new Error(
        "telegramChannel requires a non-empty secretToken (the webhook secret_token; an unset one accepts forged updates)",
      );
    }
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
          log.warn(
            "[telegram] privacy mode is on: the bot only sees @mentions / replies / commands, so group " +
              "context (un-summoned messages) won't be captured. Disable it via @BotFather → /setprivacy.",
          );
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

    // The channel-state convention: this channel's durable home is `<stateRoot>/channels/telegram` (engine state at
    // the root, channel state under `channels/<kind>/`).
    if (!isAbsolute(stateRoot)) {
      throw new Error(`telegramChannel requires an absolute ctx.stateRoot, got "${stateRoot}"`);
    }
    const stateHome = join(stateRoot, "channels", "telegram");
    ensureStateHome(stateHome); // buffers/files may carry chat content; the agent .gitignore covers .state/
    const buffer = createContextBuffer(join(stateHome, "buffers.json"));
    // Durable turn intent (L1): persist an accepted turn pre-ACK, remove it when the turn ends; a crash leaves it for
    // replay on the next start.
    const store = createTurnStore(join(stateHome, "turns.json"));
    const targetOf = (r: PendingTurn): Target => ({ chatId: r.chatId, threadId: r.threadId, replyTo: r.replyTo });

    // Tell the asker when a turn is dropped at the execution ceiling: the chain's end needs a signal, not just an
    // operator log line.
    const notifyDropped = (r: PendingTurn): void => {
      const body = "⚠️ I couldn’t complete an earlier request — please ask again.";
      const sent =
        r.previewId !== undefined
          ? editMessageText(apiBaseUrl, botToken, targetOf(r), r.previewId, body, { html: false })
          : sendMessage(apiBaseUrl, botToken, targetOf(r), body, { html: false }).then(() => {});
      void sent.catch((e) =>
        log.warn(`[telegram] could not notify a dropped turn (session=${r.session}): ${String(e)}`),
      );
    };

    const runner = createTurnRunner<PendingTurn, StoredTurn, BufferEntry>({
      label: "[telegram]",
      store,
      buffer,
      toStored: ({ previewId: _live, ...intent }) => ({ ...intent, attempts: 0 }),
      fromStored: ({ attempts: _a, ...intent }) => ({ ...intent, previewId: undefined }),
      bufferKey: (rec) => rec.placeKey,
      where: (rec) => `chat=${rec.chatId}${rec.threadId !== undefined ? ` thread=${rec.threadId}` : ""}`,
      // Queue feedback: when this session already has a turn running/queued, a silent wait reads as "the bot ignored
      // me" once the current turn runs long.
      onQueuedBehind: (rec) => ({
        done: sendMessage(
          apiBaseUrl,
          botToken,
          targetOf(rec),
          "⏳ Queued — I’ll start once the current task finishes.",
          {
            html: false,
          },
        ).then(
          (id) => {
            if (id !== undefined) rec.previewId = id;
          },
          (e) => log.warn(`[telegram] queue notice failed (the turn still runs): ${String(e)}`),
        ),
      }),
      // Its ⏳ notice (if any) now falsely reads "Queued": delete it best-effort.
      onDeferred: (rec) => {
        if (rec.previewId !== undefined) {
          void callApi(apiBaseUrl, botToken, "deleteMessage", {
            chat_id: rec.chatId,
            message_id: rec.previewId,
          }).catch(() => {});
        }
      },
      notifyDropped,
      execute: (rec, discussion, onCompleted) =>
        telegramReply(
          telegramTurnStream(
            agent,
            rec.session,
            `${discussionBlock(discussion.text)}${rec.baseText}`,
            { api: apiBaseUrl, botToken, chatId: rec.chatId, filesDir: join(stateHome, "files") },
            {
              primary: { imageFileIds: rec.imageFileIds, fileIds: rec.fileIds },
              buffered: collectAttachments(discussion.consumed, {
                files: new Set(rec.fileIds),
                images: new Set(rec.imageFileIds),
              }),
            },
            onCompleted,
          ),
          apiBaseUrl,
          botToken,
          targetOf(rec),
          formatError,
          rec.previewId,
        ),
    });
    runner.recover();

    const handler = async (req: Request): Promise<Response> => {
      if (req.method !== "POST") return text("POST only\n", 405);
      // Fail closed: a missing/wrong secret token is 401, never routed.
      if (!secretEquals(req.headers.get("x-telegram-bot-api-secret-token"), secretToken)) {
        return text("invalid secret token\n", 401);
      }
      const body = await readBodyCapped(req, MAX_UPDATE_BYTES);
      if ("tooLarge" in body) return text("payload too large\n", 413);
      let update: TelegramUpdate;
      try {
        update = JSON.parse(body.text) as TelegramUpdate;
      } catch {
        return text("invalid json\n", 400);
      }

      // Decide whether/where to answer, then run the turn.
      const m = pickMessage(update);
      if (!m) return new Response(null, { status: 200 });
      const placeKey = m.message_thread_id ? `${m.chat.id}:${m.message_thread_id}` : `${m.chat.id}`;
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
            replyTo: m.reply_to_message?.message_id,
            fileIds: fileIds.length ? fileIds : undefined,
            imageIds: imageIds.length ? imageIds : undefined,
          });
        }
        return new Response(null, { status: 200 });
      }
      const session = r.session ?? placeKey;
      const chatId = r.chatId ?? m.chat.id;
      // Reply to the summoning message in groups (threads the answer under the asker); a 1:1 DM needs no reply-quote.
      const threadId = r.threadId ?? m.message_thread_id;
      const sameTarget = String(chatId) === String(m.chat.id) && threadId === m.message_thread_id;
      const replyTo = m.chat.type !== "private" && sameTarget ? m.message_id : undefined;
      // Explicit user stop (`/stop`): a control action, never a turn — it must not queue behind the run it stops.
      if (telegramStop(update, { botUsername: mentionName, botId })) {
        const feedback = await dispatchStop(control, session, "[telegram]");
        await sendMessage(apiBaseUrl, botToken, { chatId, threadId, replyTo }, feedback, { html: false }).catch((e) =>
          log.warn(`[telegram] stop feedback failed: ${String(e)}`),
        );
        return new Response(null, { status: 200 });
      }
      const baseText = r.text ?? telegramEnvelope(m);
      const imageFileIds = extractImages(m);
      const fileIds = extractFiles(m);
      if (baseText.trim() !== "" || imageFileIds.length > 0 || fileIds.length > 0) {
        // Everything the turn needs, as a plain record; persisted pre-ACK then run serially per session.
        runner.submit(
          {
            id: `${update.update_id}`,
            session,
            placeKey,
            baseText,
            chatId,
            threadId,
            replyTo,
            imageFileIds,
            fileIds,
          },
          true,
        );
      }
      return new Response(null, { status: 200 });
    };
    // Test/observability seam: await the fire-and-forget turns this handler enqueues.
    (handler as typeof handler & { turnsIdle?: () => Promise<void> }).turnsIdle = () => runner.idle();
    return { "POST /telegram": handler };
  };
}
