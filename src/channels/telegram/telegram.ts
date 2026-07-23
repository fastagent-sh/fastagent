/**
 * Telegram bot channel: verify the webhook secret token → decide via `route(update)` → run the turn →
 * stream the agent's reply back to the chat, ACK 200. Reply model A: the channel holds the bot token
 * and posts the reply itself (chat UX), unlike the github channel's fire-and-forget. No SDK — inbound
 * is a JSON POST, outbound is a `fetch` to the Bot API. The developer writes only `route` (policy); the
 * channel owns transport + format + attachments.
 *
 * This file is the Telegram WIRING: ingress (secret/body cap/JSON) + the per-turn lifecycle + composition.
 * Every other concern lives in its own module, each owning its invariants:
 *   - parse.ts          pure message parsing: field extraction, prompt envelope, summon/route policy
 *   - invoke-turn.ts    run one turn: assemble inputs (resolve attachments) + stream `agent.invoke`
 *   - turn-queue.ts     in-memory per-session serial execution (FIFO; one turn at a time per session)
 *   - turn-store.ts     durable turn intent (L1): pre-ACK persist, replay a crash-surviving turn
 *   - context-buffer.ts un-summoned group discussion, folded into the next answered turn
 *   - preview.ts        the live-preview pump ("💭 Thinking…" → edits → final answer) + terminal writes
 *   - telegram-api.ts   the single Bot API pipeline (timeouts, 429, ok-gating, HTML-aware split)
 *   - state.ts          atomic state files under the channel-state home
 *
 * Threaded Mode (topics in private chats, a @BotFather toggle) is auto-adapted: an update carrying
 * message_thread_id replies into that thread; without one the chat is linear. Same code, both modes.
 *
 * Authored against the public `@fastagent-sh/fastagent` surface only (the contract + the channel-authoring
 * kit: readBodyCapped / text), so it is exactly what a third-party `fastagent-channel-*` package would write.
 */
import { timingSafeEqual } from "node:crypto";
import { isAbsolute, join } from "node:path";
import type { ChannelModule } from "../../host/node.ts";
import { log } from "../../log.ts";
import { readBodyCapped } from "../body.ts";
import { text } from "../respond.ts";
import { invokeTurn } from "./invoke-turn.ts";
import { collectAttachments, createContextBuffer } from "./context-buffer.ts";
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
} from "./parse.ts";
import { type TelegramFailure, defaultErrorMessage, streamReply } from "./preview.ts";
import { ensureStateHome } from "../state.ts";
import { dispatchStop } from "../stop-command.ts";
import { type Target, callApi, editMessageText, sendMessage } from "./telegram-api.ts";
import { createTurnQueue } from "../turn-queue.ts";
import { type StoredTurn, createTurnStore } from "./turn-store.ts";

// Re-export the public surface authored elsewhere, so `@fastagent-sh/fastagent/telegram` keeps one entry point.
export { defaultTelegramRoute, telegramEnvelope };
export type { TelegramFailure, TelegramMessage, TelegramRoute, TelegramUpdate };

/** Execution ceiling: a turn that has STARTED running this many times without finishing is dropped
 *  rather than run again (a poison turn must not loop forever under a restart policy). Counted per turn
 *  at dequeue, so a never-run turn queued behind a poison one keeps its full budget.
 *
 *  Known limitation: `startAttempt` cannot tell a self-inflicted process crash from an external SIGTERM
 *  (no graceful drain), so a legitimately LONG turn interrupted by this many successive deploys is
 *  dropped ("please ask again") as if it were poison. Accepted: catching SIGTERM to spare it would
 *  reintroduce the drain the design refuses, and a turn outliving this many deploy cycles is an outlier
 *  — raise this constant if such turns are expected. */
const MAX_TURN_ATTEMPTS = 3;

/** Update body cap — Telegram updates are small JSON; 1 MiB is generous and guards a public endpoint. */
const MAX_UPDATE_BYTES = 1 << 20;

/** One accepted turn: everything the runner needs to execute it. The executable intent is the persisted
 *  {@link StoredTurn} (so a new field the runner needs is durable by construction); PendingTurn adds only
 *  live-object fields that are NOT persisted — a restart's queue notice is gone, so `previewId` is
 *  reconstructed fresh on replay. */
interface PendingTurn extends Omit<StoredTurn, "attempts"> {
  /** The "⏳ queued" notice's message_id, when one was sent — the turn's preview takes it over. Live
   *  only; never persisted (a replayed turn sends a fresh preview). */
  previewId?: number;
}

export interface TelegramChannelOptions {
  /** Webhook secret token (the `secret_token` you set via setWebhook); verifies inbound updates. */
  secretToken: string;
  /** Bot token — used to send the agent's reply via the Bot API. */
  botToken: string;
  /** Policy: whether/where to answer an update (return null to ignore). Defaults to {@link defaultTelegramRoute}. */
  route?: (update: TelegramUpdate) => TelegramRoute | null;
  /**
   * Customer-facing failure text for the chat (the dev-facing full `details` always go to the operator
   * log). Return a string to send it, or undefined/"" to stay silent. Default: a neutral message keyed
   * on `retryable`. A developer's own bot can surface the raw details, e.g. `(f) => `⚠️ ${f.details}``.
   */
  onError?: (failed: TelegramFailure) => string | undefined;
  /** Bot @username for group @mention summon by the default route (else resolved via getMe). */
  botUsername?: string;
  /** Bot API base, for tests. Defaults to the public Telegram endpoint. */
  apiBaseUrl?: string;
}

/** Constant-time compare so the secret-token check leaks no timing signal. */
function tokenMatches(header: string, secret: string): boolean {
  const a = Buffer.from(header);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Build a Telegram bot channel: policy options in, a {@link ChannelModule} out. The framework (or an
 * embedder) mounts it with the context — `telegramChannel(opts)` in `channels/telegram.ts` is the whole
 * glue; `agent` and the state root arrive via ctx, never through user code. Mounts `POST /telegram`
 * (the path `--tunnel` webhook registration expects). The adapter owns that route key; to serve the
 * SAME instance at a different path (e.g. behind a rewriting proxy), re-key the returned module:
 *   `(ctx) => ({ "POST /bot": telegramChannel(opts)(ctx)["POST /telegram"]! })`.
 * This re-routes ONE instance — it is not a way to run two telegram bots in one workspace: the state
 * home is derived from the channel kind (`<stateRoot>/channels/telegram`), so a second instance would
 * share the first's turn-store/context-buffer. One telegram instance per workspace (single-process).
 */
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
    // One getMe at startup: the bot's @username (for the default route's group @mention summon, only when
    // not supplied) and the group-privacy flag — privacy mode off is required to receive the un-summoned
    // group messages that feed the context buffer, so warn if it is on.
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
      (e) => log.warn(`[telegram] getMe failed; @mention summon + privacy check skipped: ${String(e)}`),
    );
    // A bot token is "<bot_id>:<secret>" — the bot's own id is knowable synchronously, so reply-to-bot
    // targeting is precise from the first update (no getMe race; getMe only resolves the @username).
    // Every real token parses; one that doesn't (a mock/test token) degrades visibly: reply summon stays
    // off (fail-closed in repliesToBot) until getMe supplies the username tier.
    const tokenId = Number(botToken.split(":")[0]);
    const botId = Number.isSafeInteger(tokenId) && tokenId > 0 ? tokenId : undefined;
    if (botId === undefined) {
      log.warn("[telegram] bot token has no parseable bot id — reply-to-bot summon disabled until getMe resolves");
    }
    const decide =
      route ?? ((update: TelegramUpdate) => defaultTelegramRoute(update, { botUsername: mentionName, botId }));

    // The channel-state convention: this channel's durable home is `<stateRoot>/channels/telegram`
    // (engine state at the root, channel state under `channels/<kind>/`) — derived, not an option, so
    // the operator's ONE state knob (FASTAGENT_STATE_DIR) can never be silently bypassed by glue.
    // The ctx contract says stateRoot is absolute (loadChannels enforces it); re-assert for embedders
    // that mount without the loader — a silent cwd re-anchor is the bug this contract exists to kill,
    // and every derived path (incl. attachment paths) relies on DownloadedFile's absolute-path contract.
    if (!isAbsolute(stateRoot)) {
      throw new Error(`telegramChannel requires an absolute ctx.stateRoot, got "${stateRoot}"`);
    }
    const stateHome = join(stateRoot, "channels", "telegram");
    ensureStateHome(stateHome); // create + self-ignore — buffers/files may carry chat content
    const buffer = createContextBuffer(join(stateHome, "buffers.json"));
    // Durable turn intent (L1): persist an accepted turn pre-ACK, remove it when the turn ends; a crash
    // leaves it for replay on the next start. See turn-store.ts for the at-least-once semantics.
    const store = createTurnStore(join(stateHome, "turns.json"));
    const toStored = (r: PendingTurn): StoredTurn => {
      const { previewId: _live, ...intent } = r; // drop the live-only field; TS enforces the rest is complete
      return { ...intent, attempts: 0 };
    };

    // In-memory: the in-flight "⏳ queued" notice per turn, awaited at dequeue so the turn reliably takes
    // the notice message over (rec.previewId) instead of racing it and orphaning a late-arriving notice.
    const notices = new Map<string, Promise<void>>();
    const queue = createTurnQueue<PendingTurn>({
      label: "[telegram]",
      // Queue feedback: when this session already has a turn running/queued, a silent wait reads as "the
      // bot ignored me" once the current turn runs long — tell the asker NOW (reply-quoted, so it is
      // clear whose ask is queued). Best-effort and post-ACK: a failed notice is a log line, never a
      // failed update. The turn's live preview then edits this same message in place.
      onQueuedBehind: (rec) => {
        const target: Target = {
          chatId: rec.chatId,
          threadId: rec.threadId,
          replyTo: rec.replyTo,
        };
        notices.set(
          rec.id,
          sendMessage(apiBaseUrl, botToken, target, "⏳ Queued — I’ll start once the current task finishes.", {
            html: false,
          }).then(
            // The runner holds this same `rec` object, so mutating it here (gated by the notices await at
            // dequeue below) is what hands the turn its preview message id.
            (id) => {
              if (id !== undefined) rec.previewId = id;
            },
            (e) => log.warn(`[telegram] queue notice failed (the turn still runs): ${String(e)}`),
          ),
        );
      },
      run: async (rec) => {
        // Runs at DEQUEUE time (serialized), so the lifecycle log and engine turn reflect the actual
        // execution order rather than arrival.
        // Settle the queue notice (if any) so rec.previewId is final. NOT free: a slow (not failed)
        // notice delays this turn's start by up to the API timeout — accepted, because racing it would
        // orphan the ⏳ message and double-post a placeholder; in the common path the notice resolved
        // while the previous turn was still running, so this await is instant. BEFORE the ceiling check
        // so a dropped turn's notice is settled/cleared too (rec.previewId lets notifyDropped take it over).
        await notices.get(rec.id);
        notices.delete(rec.id);
        // Count this execution against the durable record (poison-turn ceiling) before running it again.
        const decision = store.startAttempt(rec.id, MAX_TURN_ATTEMPTS);
        if (decision === "exceeded") {
          // Started MAX_TURN_ATTEMPTS times without finishing — tell the asker (reusing its ⏳ notice if
          // any), drop it.
          notifyDropped(rec);
          return;
        }
        if (decision === "defer") {
          // Couldn't record the attempt (disk failure): skip this cycle. A restart replays it, so no notify
          // (telling the asker to re-ask would double-answer once the deferred turn runs). Two accepted
          // edges of this rare disk-failure corner: (1) the session chain proceeds to the next queued turn,
          // so a deferred turn can replay AFTER its successors — a per-session FIFO reorder; (2) its ⏳ notice
          // (if it was queued behind another turn) now falsely reads "Queued", so delete it best-effort — the
          // eventual replay sends a fresh preview, and leaving it would orphan a stale message above that.
          if (rec.previewId !== undefined) {
            void callApi(apiBaseUrl, botToken, "deleteMessage", {
              chat_id: rec.chatId,
              message_id: rec.previewId,
            }).catch(() => {});
          }
          return;
        }
        const startedAt = Date.now();
        const where = `chat=${rec.chatId}${rec.threadId !== undefined ? ` thread=${rec.threadId}` : ""}`;
        log.info(`[telegram] turn start: turn=${rec.id} session=${rec.session} ${where}`);
        // Fold the un-summoned discussion since the last answered turn into the prompt; it is cleared
        // only when the turn COMPLETES (then it lives in the session).
        const { text: recent, consumed } = buffer.peek(rec.placeKey);
        const prompt = recent ? `[recent group discussion:\n${recent}\n]\n\n${rec.baseText}` : rec.baseText;
        const buffered = collectAttachments(consumed, {
          files: new Set(rec.fileIds),
          images: new Set(rec.imageFileIds),
        });
        const target: Target = {
          chatId: rec.chatId,
          threadId: rec.threadId,
          replyTo: rec.replyTo,
        };
        try {
          await streamReply(
            invokeTurn(
              agent,
              rec.session,
              prompt,
              {
                api: apiBaseUrl,
                botToken,
                chatId: rec.chatId,
                filesDir: join(stateHome, "files"),
              },
              {
                primary: {
                  imageFileIds: rec.imageFileIds,
                  fileIds: rec.fileIds,
                },
                buffered,
              },
              () => {
                // On completed, ORDER the two durable clears so a crash between them can't replay a
                // context-stripped turn: drop the intent FIRST (a crash after this won't replay it), THEN
                // commit the context buffer (a crash before this just re-folds the same context into the
                // next summon — harmless and additive). The reverse order would leave intent+no-context.
                store.remove(rec.id);
                buffer.commit(rec.placeKey, consumed);
              },
            ),
            apiBaseUrl,
            botToken,
            target,
            formatError,
            rec.previewId,
          );
          log.info(`[telegram] turn done: turn=${rec.id} session=${rec.session} (${Date.now() - startedAt}ms)`);
        } catch (error) {
          log.error(
            `[telegram] turn failed: turn=${rec.id} session=${rec.session} (${Date.now() - startedAt}ms): ${String(error)}`,
          );
        } finally {
          // Fallback removal for the caught-error paths (a `failed` event or a transport throw): those
          // never reach the completed hook above, which is where a completed turn removes its intent in
          // order. Idempotent — a second remove after the completed hook is a no-op. Only an INTERRUPTED run
          // (this finally never runs — a crash or a SIGTERM deploy, no graceful drain) leaves the record for
          // replay; a transport throw is dropped, not retried (safe retry needs an L2 delivery key).
          store.remove(rec.id);
        }
      },
    });

    // Accept a turn: persist its intent before the ACK (durable), then enqueue it. Recovery re-enqueues a
    // crash-surviving turn WITHOUT re-persisting (it is already on disk with a bumped attempt count).
    const submit = (rec: PendingTurn, persist: boolean): void => {
      if (persist) store.add(toStored(rec)); // pre-ACK: a failed write throws → webhook 500 → redeliver
      queue.accept(rec);
    };

    // Tell the asker when a turn is dropped at the execution ceiling: the chain's end needs a signal, not
    // just an operator log line. Take over the ⏳ "Queued" notice in place if the turn had one (else send
    // fresh) — leaving it pinned at "Queued" while sending a separate failure would double-post. Best-
    // effort, like the queue notices.
    const notifyDropped = (r: PendingTurn): void => {
      const body = "⚠️ I couldn’t complete an earlier request — please ask again.";
      const target: Target = {
        chatId: r.chatId,
        threadId: r.threadId,
        replyTo: r.replyTo,
      };
      const sent =
        r.previewId !== undefined
          ? editMessageText(apiBaseUrl, botToken, target, r.previewId, body, {
              html: false,
            })
          : sendMessage(apiBaseUrl, botToken, target, body, {
              html: false,
            }).then(() => {});
      void sent.catch((e) =>
        log.warn(`[telegram] could not notify a dropped turn (session=${r.session}): ${String(e)}`),
      );
    };

    // Re-enqueue turns a prior crash left mid-flight (ACKed but unfinished). Synchronous at construction:
    // the queue runs them on the next tick, once this factory returns and the event loop turns. The
    // execution ceiling is enforced per turn at dequeue (run), not here — a never-run turn keeps its budget.
    const recovered = store.recover();
    if (recovered.length > 0) log.info(`[telegram] recovering ${recovered.length} unfinished turn(s) from a prior run`);
    for (const { attempts: _a, ...intent } of recovered) submit({ ...intent, previewId: undefined }, false);

    const handler = async (req: Request): Promise<Response> => {
      if (req.method !== "POST") return text("POST only\n", 405);
      // Fail closed: a missing/wrong secret token is 401, never routed.
      if (!tokenMatches(req.headers.get("x-telegram-bot-api-secret-token") ?? "", secretToken)) {
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

      // Decide whether/where to answer, then run the turn. ACK 200 immediately (the turn may outlast the
      // webhook timeout); lifecycle goes to stderr — after the 200 there is no response body, so those
      // lines are the operator's only signal.
      const m = pickMessage(update);
      if (!m) return new Response(null, { status: 200 });
      const placeKey = m.message_thread_id ? `${m.chat.id}:${m.message_thread_id}` : `${m.chat.id}`;
      const r = decide(update);
      if (!r) {
        // Not summoned: in a group, record the message so a later summon has the discussion (needs privacy
        // off to be delivered here at all). Empty/service messages and non-group chats keep no buffer.
        const isGroup = m.chat.type === "group" || m.chat.type === "supergroup";
        const content = messageText(m);
        if (isGroup && content) {
          // OWN attachments only: each message is its own buffer entry, so a reply's referenced
          // attachment is already (or will be) the other entry's — recounting it here would duplicate
          // downloads and squeeze the attachment cap.
          const fileIds = ownFiles(m);
          const imageIds = ownImages(m);
          // A captioned attachment renders as its caption — append the attachment marker so the fold
          // ALWAYS labels attachments (that label + sender is all the attribution a photo gets).
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
      {
        const session = r.session ?? placeKey;
        const chatId = r.chatId ?? m.chat.id;
        // Reply to the summoning message in groups (threads the answer under the asker); a 1:1 DM needs no
        // reply-quote. Only when the RESOLVED target is the message's own chat+thread: a route that
        // redirects elsewhere must not carry a reply_parameters that resolves in the wrong place (fail, or
        // quote a same-id message there). Compare VALUES, not whether the route touched the field — a route
        // that explicitly returns the same chat/thread still quotes.
        const threadId = r.threadId ?? m.message_thread_id;
        const sameTarget = String(chatId) === String(m.chat.id) && threadId === m.message_thread_id;
        // Explicit user stop (`/stop`): a control action, never a turn — it must not queue behind the
        // run it stops. `/stop@otherbot` is not ours; a bare `/stop` always is. Awaited before the ACK:
        // dispatch + one sendMessage is fast, and a delivery failure logs instead of failing the webhook.
        const stopMatch = /^\/stop(?:@([A-Za-z0-9_]+))?$/i.exec(messageText(m).trim());
        if (stopMatch && (!stopMatch[1] || stopMatch[1].toLowerCase() === mentionName?.toLowerCase())) {
          const feedback = await dispatchStop(control, session, "[telegram]");
          const target: Target = {
            chatId,
            threadId,
            replyTo: m.chat.type !== "private" && sameTarget ? m.message_id : undefined,
          };
          await sendMessage(apiBaseUrl, botToken, target, feedback, { html: false }).catch((e) =>
            log.warn(`[telegram] stop feedback failed: ${String(e)}`),
          );
          return new Response(null, { status: 200 });
        }
        const baseText = r.text ?? telegramEnvelope(m);
        const imageFileIds = extractImages(m);
        const fileIds = extractFiles(m);
        if (baseText.trim() !== "" || imageFileIds.length > 0 || fileIds.length > 0) {
          // Everything the turn needs, as a plain record; persisted pre-ACK then run serially per session.
          submit(
            {
              id: `${update.update_id}`,
              session,
              placeKey,
              baseText,
              chatId,
              threadId,
              replyTo: m.chat.type !== "private" && sameTarget ? m.message_id : undefined,
              imageFileIds,
              fileIds,
            },
            true,
          );
        }
      }
      return new Response(null, { status: 200 });
    };
    // Test/observability seam: await the fire-and-forget turns this handler enqueues. Inert in production
    // (nothing reads it; the runtime never drains — see turn-queue), it lets a test await a turn
    // deterministically instead of polling for side effects to settle.
    (handler as typeof handler & { turnsIdle?: () => Promise<void> }).turnsIdle = () => queue.idle();
    return { "POST /telegram": handler };
  };
}
