/** Canonical Feishu live-preview rendering (also reused by Lark compatibility). */
import { setTimeout as sleep } from "node:timers/promises";
import type { AgentEvent } from "../../agent.ts";
import * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import * as Clock from "effect/Clock";
import { previewPump, renderReply } from "../kit/delivery.ts";
import { type PortFailure, portJoin } from "../../effect-port.ts";
import { log } from "../../log.ts";
import {
  ANSWER_ELEMENT_ID,
  CARD_MARKDOWN_MAX_BYTES,
  PROCESS_ELEMENT_ID,
  cardEntityContent,
  finalCardJson,
  streamingCardJson,
} from "./card.ts";
import { type FeishuApi, type FeishuTarget, chunkFeishuText, isCardStreamingClosed } from "./feishu-api.ts";
import { DROPPABLE_FRAME } from "../kit/transport.ts";
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
import { truncateCodePointPrefix, truncateUtf8 } from "../kit/text.ts";

/** A terminal failure, as the channel hands it to `onError` — the shared channel shape. */
export type FeishuFailure = ChannelFailure;
export { defaultErrorMessage };

/** How often (ms) to push a live-preview snapshot; tool events still flush on the next loop. */
const STREAM_THROTTLE_MS = 1000;

/** How much of the (growing) reasoning to peek at in the live view — the most recent tail. */
const THINKING_PREVIEW = 280;

/** Cap (code points) on the whole process block — thinking tail + tool lines + retry notice. */
const PROCESS_MAX_POINTS = 1000;

/** Cap the live answer to the card budget, PREFIX-STABLE. */
function capBytes(s: string, maxBytes: number): string {
  return truncateUtf8(s, maxBytes);
}

/** Tail-select COMPLETE lines within a code-point budget — the process block's cap. */
function tailLines(text: string, maxPoints: number): string {
  if (Array.from(text).length <= maxPoints) return text;
  const lines = text.split("\n");
  const kept: string[] = [];
  let used = 2; // the leading "…\n" elision marker
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    const cost = Array.from(line).length + (kept.length > 0 ? 1 : 0); // +1 joining newline
    if (used + cost > maxPoints) break;
    used += cost;
    kept.unshift(line);
  }
  if (kept.length === 0) return truncateCodePointPrefix(lines.at(-1) ?? "", maxPoints);
  return `…\n${kept.join("\n")}`;
}

/** A visible preview mounted into the chat. */
export type MountedFeishuPreview =
  | { kind: "card"; cardId: string; messageId: string }
  | { kind: "text"; messageId: string };

/** The preview lifecycle also needs a no-message state when setup failed entirely. */
type Preview = MountedFeishuPreview | { kind: "none" };

/** The terminal-write POLICY: resolve the preview into `text`. */
async function finalize(
  api: FeishuApi,
  target: FeishuTarget,
  preview: Preview,
  text: string,
  seq: () => number,
): Promise<void> {
  if (text.trim() === "") {
    if (preview.kind !== "none") await api.deleteMessage(preview.messageId).catch(() => {});
    return;
  }
  if (preview.kind === "card") {
    const [head, ...rest] = chunkFeishuText(text, CARD_MARKDOWN_MAX_BYTES);
    let settled = false;
    try {
      await api.updateCard(preview.cardId, finalCardJson(head ?? ""), seq());
      settled = true;
    } catch {
      // Settle failed (card expired / rejected) — fall through to delete + fresh send below.
    }
    if (settled) {
      // Threaded continuations must keep reply_in_thread.
      const continuationTarget = target.replyInThread ? target : { chatId: target.chatId };
      for (const chunk of rest) await api.sendText(continuationTarget, chunk);
      return;
    }
  }
  if (preview.kind === "text") {
    if (chunkFeishuText(text).length === 1) {
      try {
        await api.editTextMessage(preview.messageId, text);
        return;
      } catch {
        // Edit failed (edit window / count / policy) — fall through to delete + fresh send below.
      }
    }
  }
  if (preview.kind !== "none") await api.deleteMessage(preview.messageId).catch(() => {});
  await api.sendText(target, text);
}

/**
 * Mount one preview message: preferably a streaming card entity (`initial` seeds the process element; the answer
 * element starts empty), with a static text message as the visible fallback.
 */
export async function mountFeishuPreview(
  api: FeishuApi,
  target: FeishuTarget,
  initial: string,
  label = "[feishu]",
): Promise<MountedFeishuPreview> {
  try {
    const cardId = await api.createCard(streamingCardJson(initial));
    const content = cardEntityContent(cardId);
    const mountOnce = (): Promise<string | undefined> =>
      target.replyTo !== undefined
        ? api.replyMessage(target.replyTo, "interactive", content, { replyInThread: target.replyInThread })
        : api.sendMessage(target.chatId, "interactive", content);
    let messageId: string | undefined;
    // Field-observed: the mount can reject a JUST-minted card id (code 230099 / "cardid is invalid").
    for (let attempt = 1; ; attempt++) {
      try {
        messageId = await mountOnce();
        break;
      } catch (e) {
        if (attempt >= 3 || !/230099|11310|cardid is invalid/i.test(String(e))) throw e;
        log.warn(
          `${label} mount rejected the fresh card (card=${cardId}, attempt ${attempt}) — retrying: ${String(e)}`,
        );
        await sleep(attempt * 400);
      }
    }
    if (messageId === undefined) throw new Error("interactive send returned ok without a message_id");
    return { kind: "card", cardId, messageId };
  } catch (e) {
    // Card tier failed — degrade to a text placeholder with NO live updates (the text tier's 20-edit cap is spent on
    // terminal writes only).
    log.warn(`${label} streaming card unavailable — live preview degrades to a static placeholder: ${String(e)}`);
    const messageId =
      target.replyTo !== undefined
        ? await api.replyMessage(target.replyTo, "text", JSON.stringify({ text: initial }), {
            replyInThread: target.replyInThread,
          })
        : await api.sendMessage(target.chatId, "text", JSON.stringify({ text: initial }));
    if (messageId === undefined) throw new Error("text preview send returned ok without a message_id");
    return { kind: "text", messageId };
  }
}

/** Settle an already-mounted queue preview without starting an Agent stream (the poison/defer paths). */
export async function settleFeishuPreview(
  api: FeishuApi,
  target: FeishuTarget,
  preview: MountedFeishuPreview | undefined,
  text: string,
): Promise<void> {
  let sequence = 0;
  await finalize(api, target, preview ?? { kind: "none" }, text, () => ++sequence);
}

/**
 * Consume one turn's event stream into a Feishu-compatible chat, live (see the module header for the preview model).
 */
export function feishuReply(
  events: Stream.Stream<AgentEvent, PortFailure>,
  api: FeishuApi,
  target: FeishuTarget,
  formatError: (failed: FeishuFailure) => string | undefined,
  initialPreview?: MountedFeishuPreview,
  label = "[feishu]",
) {
  return Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const now = () => clock.currentTimeMillisUnsafe();
    // Event → view-state reduction is the shared machine (preview-kit); this renderer owns the reveal policy, the
    // card-budget caps, and delivery below.
    const turn = createTurnView();
    const processView = (): string => {
      const v = composeTurnBody([
        thinkingLine(turn, THINKING_PREVIEW),
        toolLines(turn),
        turn.retrying ? RETRY_NOTICE : "",
      ]);
      if (v !== "") return tailLines(v, PROCESS_MAX_POINTS);
      // No process content: the placeholder covers only the silence BEFORE the answer reveals.
      return revealedAnswer(turn, STREAM_THROTTLE_MS, now()).trim() === "" ? THINKING_PLACEHOLDER : "";
    };
    const answerView = (): string => capBytes(revealedAnswer(turn, STREAM_THROTTLE_MS, now()), CARD_MARKDOWN_MAX_BYTES);

    // The live preview is ONE message: either the queue card/text handed in by the wiring, or a preview mounted
    // lazily on this turn's first flush.
    let preview: Preview = initialPreview ?? { kind: "none" };
    let setupAttempted = initialPreview !== undefined;
    let sequence = 0;
    const nextSeq = (): number => ++sequence;
    let streamDead = false; // the platform closed streaming (idle timeout) — freeze the live view
    let lastProcess = "";
    let lastAnswer = "";

    const flushPreview = async (): Promise<void> => {
      const process = processView();
      if (!setupAttempted) {
        setupAttempted = true;
        // The mount seeds the process element with the current view; the answer element starts empty (card.ts), so
        // the first answer snapshot is a clean prefix extension.
        preview = await mountFeishuPreview(api, target, process, label);
        lastProcess = process;
        return;
      }
      if (preview.kind !== "card" || streamDead) return; // text tier / dead stream: frozen until the terminal write
      try {
        // `last*` advances BEFORE each write: a frame that fails for a non-streaming reason is logged once (the
        // pump's onError) and not re-sent until its content actually changes.
        const answer = answerView();
        // Never write an empty answer snapshot — the element is born empty and the answer only grows.
        if (answer !== "" && answer !== lastAnswer) {
          lastAnswer = answer;
          await api.updateCardElement(preview.cardId, ANSWER_ELEMENT_ID, answer, nextSeq(), DROPPABLE_FRAME);
        }
        if (process !== lastProcess) {
          lastProcess = process;
          await api.updateCardElement(preview.cardId, PROCESS_ELEMENT_ID, process, nextSeq(), DROPPABLE_FRAME);
        }
      } catch (e) {
        if (isCardStreamingClosed(e)) {
          // The platform closed streaming (idle timeout).
          streamDead = true;
          log.warn(`${label} card streaming closed mid-turn — preview frozen; the final answer still lands`);
          return;
        }
        throw e;
      }
    };

    // The scoped single writer keeps card sequences ordered through the terminal update.
    const { touch, finish } = yield* previewPump({
      flush: flushPreview,
      throttleMs: STREAM_THROTTLE_MS,
      onError: (e) => log.warn(`${label} live preview failed (final reply still sends): ${String(e)}`),
    });

    touch(); // mount the "💭 Thinking…" preview immediately

    yield* renderReply(events, {
      label,
      finish,
      formatError,
      onEvent: (event) => {
        if (applyTurnEvent(turn, event, now())) touch();
      },
      answer: () => (turn.answer.trim() !== "" ? turn.answer : "(no reply)"),
      settle: (text) => portJoin(() => finalize(api, target, preview, text, nextSeq)),
    });
  });
}
