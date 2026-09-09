/**
 * Card JSON builders — PURE: the streaming-card entity (JSON 2.0) the live preview creates, the settled final card,
 * and the message content that mounts a card entity into a chat.
 */

import { truncateCodePointPrefix } from "../kit/text.ts";

/** The append-only answer element's id — shared by create (card.ts) and update (preview.ts). */
export const ANSWER_ELEMENT_ID = "answer";

/** The volatile process element's id (thinking tail + tool lines + retry notice; live-only). */
export const PROCESS_ELEMENT_ID = "process";

/** Byte budget for markdown carried by ONE card (entity cap 30 KB minus JSON envelope + escaping room). */
export const CARD_MARKDOWN_MAX_BYTES = 20 * 1024;

/** Character budget for the settled card's summary (the chat-list / push-notification preview). */
const SUMMARY_MAX_CHARS = 60;

/**
 * The answer's first line as plain text — what the chat list and the push notification show for the settled card
 * (`config.summary.content`).
 */
export function cardSummary(markdown: string): string {
  const line =
    markdown
      .replace(/```[\s\S]*?(```|$)/g, " ") // fenced code is never a readable one-line preview
      .split("\n")
      .map((l) =>
        l
          .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/, "") // heading / quote / list markers
          .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images → alt text
          .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links → link text
          .replace(/[*_~`]/g, "")
          .trim(),
      )
      .find((l) => l !== "") ?? "";
  return truncateCodePointPrefix(line, SUMMARY_MAX_CHARS);
}

interface CardElement {
  tag: "markdown";
  content: string;
  element_id: string;
}

function cardJson(elements: CardElement[], streaming: boolean, summary?: string): string {
  return JSON.stringify({
    schema: "2.0",
    config: {
      streaming_mode: streaming,
      update_multi: true,
      // Only the settled card sets a summary — while streaming, the platform's default (a localized "[Generating…]")
      // is better than any fixed text we could pin.
      ...(summary ? { summary: { content: summary } } : {}),
    },
    body: { elements },
  });
}

/**
 * The live-preview card entity: streaming on, the process element seeded with the placeholder/queue status and the
 * answer element seeded EMPTY (the platform accepts an empty markdown element; it renders zero-height until the first
 * answer snapshot lands as a clean prefix extension of "").
 */
export function streamingCardJson(initialProcess: string): string {
  return cardJson(
    [
      { tag: "markdown", content: initialProcess, element_id: PROCESS_ELEMENT_ID },
      { tag: "markdown", content: "", element_id: ANSWER_ELEMENT_ID },
    ],
    true,
  );
}

/**
 * The settled card: final markdown alone (the process block was preview-only), streaming off (stops the client's
 * streaming affordance), plus the answer-derived summary so the chat list / notification shows the reply, not
 * "[Card]".
 */
export function finalCardJson(markdown: string): string {
  return cardJson(
    [{ tag: "markdown", content: markdown, element_id: ANSWER_ELEMENT_ID }],
    false,
    cardSummary(markdown),
  );
}

/** The `interactive` message content that mounts a card ENTITY (vs an inline static card). */
export function cardEntityContent(cardId: string): string {
  return JSON.stringify({ type: "card", data: { card_id: cardId } });
}
