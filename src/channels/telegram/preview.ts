/**
 * Live-preview rendering: consume one turn's event stream into a Telegram chat. A single real message
 * is sent once ("💭 Thinking…", or an already-sent "⏳ queued" notice is taken over), then
 * editMessageText'd in place with the latest tool calls + partial text (PLAIN — a partial answer may
 * carry unbalanced HTML); on completion the same message is edited into the final answer as HTML. One
 * message, works in groups and private (unlike sendMessageDraft, which is private/forum-topic only).
 */
import type { AgentEvent } from "../../agent.ts";
import * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import * as Clock from "effect/Clock";
import { previewPump, renderReply } from "../kit/delivery.ts";
import { DROPPABLE_FRAME } from "../kit/transport.ts";
import { type PortFailure, portJoin } from "../../effect-port.ts";
import {
  RETRY_NOTICE,
  THINKING_PLACEHOLDER,
  type ChannelFailure,
  applyTurnEvent,
  composeTurnBody,
  createTurnView,
  defaultErrorMessage,
  revealedAnswer,
  thinkingLine,
  toolLines,
} from "../kit/preview-kit.ts";
import { log } from "../../log.ts";
import { TELEGRAM_MAX_TEXT, type Target, callApi, editMessageText, sendMessage } from "./telegram-api.ts";

/** A terminal failure, as the channel hands it to `onError` — the shared channel shape. */
export type TelegramFailure = ChannelFailure;
export { defaultErrorMessage };

/** How often (ms) to edit the live-preview message; tool events still flush on the next loop. Edits to
 *  one message are rate-limited tighter than sends, so pace them ~1.5s (vs every token). Doubles as the
 *  answer-preview aging window (see answerView): partial answer text stays hidden until it has existed
 *  this long — one knob, same order of magnitude. */
const EDIT_THROTTLE_MS = 1500;

/** How much of the (growing) reasoning to peek at in the live view — the most recent tail. */
const THINKING_PREVIEW = 280;

/**
 * The terminal-write POLICY: resolve the single preview message into `text`. telegramReply owns the
 * preview lifecycle, so this composition of transport primitives lives here, not in telegram-api. One
 * message → edit the preview in place; if the edit fails (preview gone, or a persistent 429/5xx) fall
 * back to deleting the placeholder and sending fresh, so no "Thinking…" is left pinned above the answer.
 * Many messages → delete the preview and send the whole answer as consecutive fresh messages (editing
 * would pin the first chunk where an active group has scrolled past). No preview → fresh send. EMPTY text
 * = "say nothing" → just delete the preview.
 */
async function finalize(
  api: string,
  botToken: string,
  target: Target,
  messageId: number | undefined,
  text: string,
  opts: { html?: boolean } = {},
): Promise<void> {
  const html = opts.html ?? true;
  if (text.trim() === "") {
    if (messageId !== undefined)
      await callApi(api, botToken, "deleteMessage", { chat_id: target.chatId, message_id: messageId });
    return;
  }
  if (messageId !== undefined) {
    // "Fits in one message" is a plain length check against Telegram's limit — not chunkText, whose html
    // mode exists for SPLIT chunks and is irrelevant to an un-split text.
    if (text.length <= TELEGRAM_MAX_TEXT) {
      try {
        await editMessageText(api, botToken, target, messageId, text, { html });
        return;
      } catch {
        // Edit failed — the preview may be gone, or still there (429 retries exhausted / 5xx). Fall through
        // to delete + fresh send below so a still-present "Thinking…" is not left pinned above the answer.
      }
    }
    // Too long for one message, OR a failed single-message edit: remove the placeholder best-effort (a lingering one above
    // the answer is worse than the extra call), then send the whole reply as fresh, consecutive messages.
    await callApi(api, botToken, "deleteMessage", { chat_id: target.chatId, message_id: messageId }).catch(() => {});
  }
  await sendMessage(api, botToken, target, text, { html });
}

/**
 * Consume one turn's event stream into a Telegram chat, live (see the module header for the preview
 * model). Preview edits are best-effort (logged once if they fail); the final write is authoritative
 * and surfaces a real failure (bad token, etc.).
 */
export function telegramReply(
  events: Stream.Stream<AgentEvent, PortFailure>,
  api: string,
  botToken: string,
  target: Target,
  formatError: (failed: TelegramFailure) => string | undefined,
  previewId?: number,
) {
  return Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const now = () => clock.currentTimeMillisUnsafe();
    // Event → view-state reduction is the shared machine (preview-kit); this renderer owns the reveal
    // policy, formatting, and delivery below.
    const turn = createTurnView();
    const view = (): string => {
      const v = composeTurnBody([
        thinkingLine(turn, THINKING_PREVIEW),
        toolLines(turn),
        turn.retrying ? RETRY_NOTICE : "",
        revealedAnswer(turn, EDIT_THROTTLE_MS, now()),
      ]);
      // Before any reasoning/tool/text arrives, show an explicit placeholder rather than an empty edit.
      return v === "" ? THINKING_PLACEHOLDER : v;
    };

    // The live preview is ONE real message: sent once (capturing its id + threading under the asker),
    // then edited in place. messageId/lastSent are shared with the final write on completion.
    // `previewId`: an already-sent message to take over as the preview (the "⏳ queued" notice) — the
    // pump edits it in place, so the queue notice morphs into the live view instead of leaving an orphan.
    let messageId: number | undefined = previewId;
    let previewSent = messageId !== undefined; // a placeholder send was attempted — guards against re-sending when no id came back
    let lastSent = "";
    const flushPreview = async (): Promise<void> => {
      const text = view();
      if (text === lastSent) return; // skip an unchanged edit (Telegram rejects "message is not modified")
      lastSent = text;
      if (messageId !== undefined) {
        // plain — a partial answer may carry unbalanced HTML; droppable — see DROPPABLE_FRAME.
        await editMessageText(api, botToken, target, messageId, text, DROPPABLE_FRAME);
        return;
      }
      // No preview message yet. Send the placeholder ONCE; never re-send (that would spam a new message per
      // frame). If Telegram returns ok WITHOUT a message_id (proxy / odd API base / unparseable body) we
      // cannot edit — fail visibly and stop previewing (the final write still lands via finalize).
      //
      // NOT droppable, unlike the frames above: this send happens once and every later frame depends on
      // its id, so dropping it costs the whole turn's live preview rather than one redrawable view.
      if (previewSent) return;
      previewSent = true;
      messageId = await sendMessage(api, botToken, target, text, { html: false });
      if (messageId === undefined)
        throw new Error("telegram sendMessage returned ok without a message_id — live preview disabled for this turn");
    };

    const { touch, finish } = yield* previewPump({
      flush: flushPreview,
      throttleMs: EDIT_THROTTLE_MS,
      onError: (e) => log.warn(`[telegram] live preview failed (final reply still sends): ${String(e)}`),
    });

    touch(); // send the "💭 Thinking…" placeholder immediately

    yield* renderReply(events, {
      label: "[telegram]",
      finish,
      formatError,
      onEvent: (event) => {
        if (applyTurnEvent(turn, event, now())) touch();
      },
      answer: () => (turn.answer.trim() !== "" ? turn.answer : "(no reply)"),
      settle: (text) => portJoin(() => finalize(api, botToken, target, messageId, text)),
    });
  });
}
