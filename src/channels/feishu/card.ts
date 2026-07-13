/**
 * Card JSON builders — PURE: the streaming-card entity (JSON 2.0) the live preview creates, the settled
 * final card, and the message content that mounts a card entity into a chat. Kept out of preview.ts so
 * the card DSL is data-in → string-out and testable without the pump.
 *
 * The preview is ONE markdown element (`element_id` below) inside a card with `streaming_mode` on:
 * the pump PUTs full-text snapshots at that element (feishu-api.ts `updateCardElement`) and the client
 * renders the typewriter effect. Settling replaces the whole entity (`updateCard`) with the same
 * element, `streaming_mode` off — one write flips content and mode together.
 *
 * Budget: a card entity is capped at 30 KB, so the final answer's card chunk (and the live view) stay
 * well under it; longer answers overflow into follow-up messages (preview.ts owns that policy).
 */

import { truncateCodePointPrefix } from "./text.ts";

/** The one streamed element's id — shared by create (card.ts) and update (preview.ts). */
export const ANSWER_ELEMENT_ID = "answer";

/** Byte budget for markdown carried by ONE card (entity cap 30 KB minus JSON envelope + escaping room). */
export const CARD_MARKDOWN_MAX_BYTES = 20 * 1024;

/** Character budget for the settled card's summary (the chat-list / push-notification preview). */
const SUMMARY_MAX_CHARS = 60;

/**
 * The answer's first line as plain text — what the chat list and the push notification show for the
 * settled card (`config.summary.content`). Without it a card message previews as a generic "[Card]"
 * placeholder: the user's notification would never carry the actual answer. Markdown is stripped
 * lightly (this is a one-line teaser, not a renderer): fenced code dropped, links/images → their text,
 * emphasis/heading/list markers removed.
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

function cardJson(markdown: string, streaming: boolean, summary?: string): string {
  return JSON.stringify({
    schema: "2.0",
    config: {
      streaming_mode: streaming,
      update_multi: true,
      // Only the settled card sets a summary — while streaming, the platform's default (a localized
      // "[Generating…]") is better than any fixed text we could pin.
      ...(summary ? { summary: { content: summary } } : {}),
    },
    body: { elements: [{ tag: "markdown", content: markdown, element_id: ANSWER_ELEMENT_ID }] },
  });
}

/** The live-preview card entity: streaming on, seeded with the placeholder/first view. */
export function streamingCardJson(initial: string): string {
  return cardJson(initial, true);
}

/** The settled card: final markdown, streaming off (stops the client's streaming affordance), plus
 *  the answer-derived summary so the chat list / notification shows the reply, not "[Card]". */
export function finalCardJson(markdown: string): string {
  return cardJson(markdown, false, cardSummary(markdown));
}

/** The `interactive` message content that mounts a card ENTITY (vs an inline static card). */
export function cardEntityContent(cardId: string): string {
  return JSON.stringify({ type: "card", data: { card_id: cardId } });
}
