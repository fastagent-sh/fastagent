/**
 * Card JSON builders — PURE: the streaming-card entity (JSON 2.0) the live preview creates, the settled
 * final card, and the message content that mounts a card entity into a chat. Kept out of preview.ts so
 * the card DSL is data-in → string-out and testable without the pump.
 *
 * The preview is ONE markdown element (`element_id` below) inside a card with `streaming_mode` on:
 * the pump PUTs full-text snapshots at that element (lark-api.ts `updateCardElement`) and the client
 * renders the typewriter effect. Settling replaces the whole entity (`updateCard`) with the same
 * element, `streaming_mode` off — one write flips content and mode together.
 *
 * Budget: a card entity is capped at 30 KB, so the final answer's card chunk (and the live view) stay
 * well under it; longer answers overflow into follow-up messages (preview.ts owns that policy).
 */

/** The one streamed element's id — shared by create (card.ts) and update (preview.ts). */
export const ANSWER_ELEMENT_ID = "answer";

/** Byte budget for markdown carried by ONE card (entity cap 30 KB minus JSON envelope + escaping room). */
export const CARD_MARKDOWN_MAX_BYTES = 20 * 1024;

function cardJson(markdown: string, streaming: boolean): string {
  return JSON.stringify({
    schema: "2.0",
    config: { streaming_mode: streaming, update_multi: true },
    body: { elements: [{ tag: "markdown", content: markdown, element_id: ANSWER_ELEMENT_ID }] },
  });
}

/** The live-preview card entity: streaming on, seeded with the placeholder/first view. */
export function streamingCardJson(initial: string): string {
  return cardJson(initial, true);
}

/** The settled card: final markdown, streaming off (stops the client's streaming affordance). */
export function finalCardJson(markdown: string): string {
  return cardJson(markdown, false);
}

/** The `interactive` message content that mounts a card ENTITY (vs an inline static card). */
export function cardEntityContent(cardId: string): string {
  return JSON.stringify({ type: "card", data: { card_id: cardId } });
}
