/**
 * Canonical Feishu live-preview rendering (also reused by Lark compatibility). The preview is ONE
 * streaming CARD (create entity → mount it with a reply/send → stream full-text snapshots at its
 * markdown element with a strictly increasing `sequence`; the client renders the typewriter effect);
 * on completion the same card is settled in place with the final answer (streaming off). Streaming
 * updates ride the cardkit quota (50 QPS per app, 10 QPS per card entity, no edit ceiling) — NOT the
 * 5 QPS per-chat message quota or
 * the 20-edit cap on text messages, which is why the preview is a card and not an edited text message.
 *
 * A queued turn mounts this same card early with its queue status, reply-quoted to that turn's source
 * message; when execution starts the preview takes the entity over in place. This mirrors Telegram's
 * one-message lifecycle without trying to change a text message into a card (which the platform does
 * not support), and keeps multiple queued asks attributable even if their card mounts race visually.
 *
 * Fallback tier (fail visibly, degrade per turn): if the card cannot be created or mounted, the turn
 * runs with a TEXT placeholder and NO live updates (text edits are capped at 20 per message, so the
 * text tier spends them only on terminal writes); if the platform closes streaming mid-turn (idle
 * timeout), the preview freezes and the settle still lands. The final write is authoritative either
 * way, mirroring the telegram preview's terminal-write matrix (completed/failed/abnormal ×
 * settle/delete+send/suppress).
 */
import { setTimeout as sleep } from "node:timers/promises";
import type { AgentEvent } from "../../agent.ts";
import { log } from "../../log.ts";
import {
  ANSWER_ELEMENT_ID,
  CARD_MARKDOWN_MAX_BYTES,
  cardEntityContent,
  finalCardJson,
  streamingCardJson,
} from "./card.ts";
import { type FeishuApi, type FeishuTarget, chunkFeishuText, isCardStreamingClosed } from "./feishu-api.ts";
import { type ChannelFailure, defaultErrorMessage, humanizeToolName, summarizeToolArgs } from "../preview-kit.ts";
import { truncateCodePointSuffix, truncateUtf8 } from "../text.ts";

/** A terminal failure, as the channel hands it to `onError` — the shared channel shape. */
export type FeishuFailure = ChannelFailure;
export { defaultErrorMessage };

/** How often (ms) to push a live-preview snapshot; tool events still flush on the next loop. Cardkit
 *  allows 10 QPS per card entity (50 per app), but one snapshot a second reads smoothly (the client
 *  animates between snapshots).
 *  Doubles as the answer-preview aging window (see answerView). */
const STREAM_THROTTLE_MS = 1000;

/** How much of the (growing) reasoning to peek at in the live view — the most recent tail. */
const THINKING_PREVIEW = 280;

/** The placeholder shown before any reasoning/tool/text arrives. */
const THINKING_PLACEHOLDER = "💭 Thinking…";

/** Cap a live view to the card budget, PREFIX-STABLE: the streaming client animates only when the old
 *  text is a prefix of the new, so an over-budget view freezes at its head rather than sliding a tail
 *  window (which would redraw the whole card every frame). The full answer still lands at settle. */
function capBytes(s: string, maxBytes: number): string {
  return truncateUtf8(s, maxBytes);
}

/** A visible preview mounted into the chat. Exported only for the channel wiring: a queued turn mounts
 * one before execution, then hands the exact entity/message to {@link streamFeishuReply} for takeover. */
export type MountedFeishuPreview =
  | { kind: "card"; cardId: string; messageId: string }
  | { kind: "text"; messageId: string };

/** The preview lifecycle also needs a no-message state when setup failed entirely. */
type Preview = MountedFeishuPreview | { kind: "none" };

/**
 * The terminal-write POLICY: resolve the preview into `text`. One card → settle it in place (final
 * markdown, streaming off); an over-budget answer settles the card with its first chunk and sends the
 * rest as follow-up messages. A failed settle falls back to delete + fresh send, so no "Thinking…" card
 * is left pinned above the answer. Text tier → ONE edit into the final text (or delete + fresh sends
 * when it doesn't fit). No preview → fresh send. EMPTY text = "say nothing" → just delete the preview.
 */
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
      // Threaded continuations must keep reply_in_thread; continuous top-level group replies intentionally
      // avoid repeating the quote on every chunk. sendText owns the same distinction for its own chunking.
      // A continuation failure propagates: the card is already authoritative, so deleting it and sending
      // the full answer again would deterministically duplicate every continuation that already landed.
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
 * Mount one preview message: preferably a streaming card entity, with a static text message as the
 * visible fallback. Queue feedback and ordinary turn startup share this constructor so a queued card
 * has exactly the same shape the stream pump expects to take over later.
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
    // Field-observed: the mount can reject a JUST-minted card id (code 230099 / "cardid is invalid")
    // — the entity is not yet visible to the IM side (eventual consistency between cardkit and IM).
    // That specific rejection gets a short backoff and another try before degrading; anything else
    // degrades immediately.
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
    // Card tier failed — degrade to a text placeholder with NO live updates (the text tier's 20-edit
    // cap is spent on terminal writes only). Visible: the operator learns why the preview is static.
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

/** Settle an already-mounted queue preview without starting an Agent stream (the poison/defer paths).
 * Card and text tiers both change in place; only a missing/failed preview sends a fresh message. */
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
 * Consume one turn's event stream into a Feishu-compatible chat, live (see the module header for the preview
 * model). Preview updates are best-effort (logged once if they fail); the final write is authoritative
 * and surfaces a real failure (bad credentials, etc.). `initialPreview`, when present, is the queued
 * turn's already-mounted card/text message: the pump and terminal write mutate that same message rather
 * than recalling it and posting another reply.
 */
export async function streamFeishuReply(
  events: AsyncIterable<AgentEvent>,
  api: FeishuApi,
  target: FeishuTarget,
  formatError: (failed: FeishuFailure) => string | undefined,
  initialPreview?: MountedFeishuPreview,
  label = "[feishu]",
): Promise<void> {
  const tools: { label: string; status: "running" | "ok" | "error" }[] = [];
  const toolIndexById = new Map<string, number>();
  let thinking = "";
  let answer = "";
  let answerPreviewSince: number | undefined;

  const mark = { running: "…", ok: "✓", error: "✗" } as const;
  const toolView = (): string => tools.map((t) => `🔧 ${t.label} ${mark[t.status]}`).join("\n");
  // Reasoning is process, not the answer: shown (capped to its tail) in the live preview only, never
  // in the settled final card (which is `answer` alone).
  const thinkingView = (): string => {
    const t = thinking.replace(/\s+/g, " ").trim();
    if (t === "") return "";
    return `💭 ${truncateCodePointSuffix(t, THINKING_PREVIEW)}`;
  };
  // The answer is hidden until its first delta has aged one STREAM_THROTTLE_MS: the pump's leading-edge
  // flush would otherwise turn the very first content delta (often a lone character) into its own frame
  // — the short-reply flicker. Aging is anchored at delta ARRIVAL (set in the event loop, not here) so
  // an in-flight update can't skew the clock; a turn completing within the window settles directly.
  const answerView = (): string => {
    if (answer.trim() === "" || answerPreviewSince === undefined) return "";
    return Date.now() - answerPreviewSince >= STREAM_THROTTLE_MS ? answer : "";
  };
  const view = (): string => {
    const v = [thinkingView(), toolView(), answerView()]
      .filter((s) => s.trim() !== "")
      .join("\n\n")
      .trim();
    return capBytes(v === "" ? THINKING_PLACEHOLDER : v, CARD_MARKDOWN_MAX_BYTES);
  };

  // The live preview is ONE message: either the queue card/text handed in by the wiring, or a preview
  // mounted lazily on this turn's first flush. `sequence` must increase strictly per card — the single-
  // writer pump guarantees it by construction. A queue card has had no updates yet, so sequence starts
  // at zero in both paths.
  let preview: Preview = initialPreview ?? { kind: "none" };
  let setupAttempted = initialPreview !== undefined;
  let sequence = 0;
  const nextSeq = (): number => ++sequence;
  let streamDead = false; // the platform closed streaming (idle timeout) — freeze the live view
  let finalized = false; // a terminal write (completed/failed) ran — the finally skips its orphan cleanup
  let lastSent = "";

  const flushPreview = async (): Promise<void> => {
    const text = view();
    if (!setupAttempted) {
      setupAttempted = true;
      preview = await mountFeishuPreview(api, target, text, label);
      lastSent = text;
      return;
    }
    if (preview.kind !== "card" || streamDead) return; // text tier / dead stream: frozen until the terminal write
    if (text === lastSent) return; // skip an unchanged snapshot
    lastSent = text;
    try {
      await api.updateCardElement(preview.cardId, ANSWER_ELEMENT_ID, text, nextSeq());
    } catch (e) {
      if (isCardStreamingClosed(e)) {
        // The platform closed streaming (idle timeout). Freeze the live view; the settle write replaces
        // the whole entity (streaming off) and still lands.
        streamDead = true;
        log.warn(`${label} card streaming closed mid-turn — preview frozen; the final answer still lands`);
        return;
      }
      throw e;
    }
  };

  // ── Live-preview pump: a SINGLE serialized writer. ──────────────────────────────────────────
  // Events mutate state (thinking / tools / answer) and mark the preview dirty; the pump pushes the
  // LATEST view() with at most ONE update in flight, paced by a throttle. One-in-flight also guarantees
  // the card's strictly-increasing `sequence` lands in order (no concurrent frames).
  let dirty = false;
  let pumping = false;
  let stopped = false;
  let previewErrLogged = false;
  let pumpDone: Promise<void> | undefined;
  let wakeThrottle: (() => void) | undefined; // set while the pump is mid-throttle; finish() cuts it short

  const runPump = async (): Promise<void> => {
    pumping = true;
    try {
      while (dirty && !stopped) {
        dirty = false;
        try {
          await flushPreview();
        } catch (e) {
          // Best-effort preview (the final write is authoritative), but a failing update must be visible —
          // log once per turn so a never-rendering preview is diagnosable, not silent.
          if (!previewErrLogged) {
            previewErrLogged = true;
            log.warn(`${label} live preview failed (final reply still sends): ${String(e)}`);
          }
        }
        if (dirty && !stopped) {
          // Pace + coalesce a burst into one snapshot. Interruptible: finish() cuts this short so the
          // final write is not delayed by up to STREAM_THROTTLE_MS after the turn completes.
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, STREAM_THROTTLE_MS);
            wakeThrottle = () => {
              clearTimeout(t);
              resolve();
            };
          });
          wakeThrottle = undefined;
        }
      }
    } finally {
      pumping = false;
    }
  };
  // Mark the preview dirty and ensure the single writer is running (an update already in flight picks
  // up the new state on its next loop). Synchronous — callers never await a network write.
  const touch = (): void => {
    dirty = true;
    if (!pumping) pumpDone = runPump();
  };

  touch(); // mount the "💭 Thinking…" preview immediately

  // Stop the pump and await any in-flight update, so the final write below is strictly the LAST one to
  // the preview (no stale frame landing after the answer).
  const finish = async (): Promise<void> => {
    stopped = true;
    wakeThrottle?.(); // cut an in-flight throttle so the final write is not delayed up to STREAM_THROTTLE_MS
    await pumpDone?.catch(() => {});
  };

  /** Terminal write, whatever tier the preview reached. */
  const settle = async (text: string): Promise<void> => {
    await finalize(api, target, preview, text, nextSeq);
  };

  try {
    for await (const e of events) {
      if (e.type === "text") {
        answer += e.delta;
        if (answerPreviewSince === undefined && answer.trim() !== "") answerPreviewSince = Date.now();
        touch();
      } else if (e.type === "thinking") {
        thinking += e.delta;
        touch();
      } else if (e.type === "tool_started") {
        const arg = summarizeToolArgs(e.args);
        toolIndexById.set(e.id, tools.length);
        const name = humanizeToolName(e.name);
        tools.push({ label: arg ? `${name} ${arg}` : name, status: "running" });
        touch();
      } else if (e.type === "tool_ended") {
        const i = toolIndexById.get(e.id);
        const t = i === undefined ? undefined : tools[i];
        if (t) t.status = e.isError ? "error" : "ok";
        touch();
      } else if (e.type === "completed") {
        await finish();
        // Settle the preview into the final answer; the persisted card is the answer alone — the
        // process (thinking/tools) was preview-only. Mark finalized BEFORE delivering: the terminal was
        // reached, so a delivery failure here is a plain failure, not an "abnormal exit" (which would
        // wrongly fire the finally's neutral-notice fallback = double delivery + wrong text).
        finalized = true;
        await settle(answer.trim() !== "" ? answer : "(no reply)");
        return;
      } else if (e.type === "failed") {
        await finish();
        // Two audiences: the chat (customer-facing — formatError, neutral by default) and the operator
        // log (dev-facing — the full details, via the throw below + the handler's catch). Same terminal
        // write as completed; an empty notice deletes the preview (suppress = no residue). Best-effort —
        // we throw below regardless.
        finalized = true;
        {
          const msg = formatError({ details: e.details, retryable: e.retryable }) ?? "";
          try {
            await settle(msg);
          } catch (deliveryError) {
            // Preserve the Agent failure as the primary error below, but keep the broken final hop in
            // the operator-visible chain — otherwise the log falsely implies the user saw the notice.
            log.error(`${label} failed to deliver the agent-failure notice: ${String(deliveryError)}`);
          }
        }
        throw new Error(`agent failed: ${e.details} (retryable=${e.retryable})`);
      }
    }
    throw new Error("stream ended without a terminal event"); // violates SPEC MUST 1
  } finally {
    await finish();
    // Abnormal exit (stream ended without a terminal, the generator threw, or the consumer abandoned):
    // no terminal write ran. Show the SAME neutral notice a `failed` event would — the preview may show
    // real partial work, so don't delete it silently, and don't leave the user in silence. A suppressing
    // onError still collapses to a delete (finalize on empty text).
    if (!finalized) {
      // retryable:false — an abnormal end (no terminal / a throw) is of UNKNOWN retryability, so use the
      // neutral "something went wrong" default rather than promising "try again" that may not help.
      const notice = formatError({ details: "the turn ended without completing", retryable: false }) ?? "";
      try {
        await settle(notice);
      } catch (deliveryError) {
        // The stream's original throw remains primary; this explicit line records that the user-facing
        // terminal notice failed too instead of silently breaking the responsibility chain.
        log.error(`${label} failed to deliver the abnormal-turn notice: ${String(deliveryError)}`);
      }
    }
  }
}
