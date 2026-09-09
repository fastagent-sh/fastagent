/**
 * The one thing a chat transport needs from its CALLER, and the one place that decision is written.
 *
 * How a platform SIGNALS a rate limit and how long it asks us to wait are real differences and stay
 * in each `*-api.ts` (Telegram's `parameters.retry_after`, Slack's `retry-after` header, Feishu's
 * `code`). WHETHER A WRITE IS WORTH WAITING FOR is not a platform difference at all: it is a fact
 * about the write, and only the caller has it.
 *
 * A live-preview FRAME is a full snapshot — the next frame redraws it and the terminal write
 * supersedes it — so absorbing a rate-limit backoff for one parks the answer, and every turn queued
 * behind it, to deliver a view nobody needs. Measured before this existed: 93 s on Telegram, 90 s on
 * Slack, 6 s on Feishu, for a single 429 on a preview edit. Such a write passes
 * {@link DROPPABLE_FRAME}: the frame is lost, the answer is not.
 *
 * NOT every write. A write whose content exists only in that call keeps the default budget —
 * Telegram's placeholder `sendMessage` (every later frame needs its id), Slack's ordered
 * `chat.appendStream` (each append carries its own content), any terminal/settle write.
 *
 * This lived in three files as three identical interfaces under three names, each with its own copy
 * of the paragraph above.
 */

/** Per-call transport options, for the distinction a transport cannot make for itself. Readonly:
 *  {@link DROPPABLE_FRAME} is one process-wide instance handed to three different transports. */
export interface CallOptions {
  /** Rate-limit attempts this call absorbs. Omitted = the transport's default budget. */
  readonly retries?: number;
}

/** A write the next one supersedes: never wait out a rate limit for it. */
export const DROPPABLE_FRAME: CallOptions = { retries: 0 };
