/**
 * Live-preview rendering: consume one turn's event stream into a Lark/Feishu chat. The preview is ONE
 * streaming CARD (create entity → mount it with a reply/send → stream full-text snapshots at its
 * markdown element with a strictly increasing `sequence`; the client renders the typewriter effect);
 * on completion the same card is settled in place with the final answer (streaming off). Streaming
 * updates ride the cardkit quota (50 QPS per app, 10 QPS per card entity, no edit ceiling) — NOT the
 * 5 QPS per-chat message quota or
 * the 20-edit cap on text messages, which is why the preview is a card and not an edited text message.
 *
 * Fallback tier (fail visibly, degrade per turn): if the card cannot be created or mounted, the turn
 * runs with a TEXT placeholder and NO live updates (text edits are capped at 20 per message, so the
 * text tier spends them only on terminal writes); if the platform closes streaming mid-turn (idle
 * timeout), the preview freezes and the settle still lands. The final write is authoritative either
 * way, mirroring the telegram preview's terminal-write matrix (completed/failed/abnormal ×
 * settle/delete+send/suppress).
 */
import { setTimeout as sleep } from "node:timers/promises";
import type { AgentEvent, Json } from "../../agent.ts";
import { log } from "../../log.ts";
import {
  ANSWER_ELEMENT_ID,
  CARD_MARKDOWN_MAX_BYTES,
  cardEntityContent,
  finalCardJson,
  streamingCardJson,
} from "./card.ts";
import { type LarkApi, type LarkTarget, chunkLarkText, isCardStreamingClosed } from "./lark-api.ts";

/** A terminal failure, as the channel hands it to `onError`. */
export interface LarkFailure {
  details: string;
  retryable: boolean;
}

/** The customer-facing default: neutral, no leaked internals; differentiate only on whether to retry. */
export function defaultErrorMessage(failed: LarkFailure): string {
  return failed.retryable ? "⚠️ Temporary problem — please try again." : "⚠️ Sorry, something went wrong.";
}

/** How often (ms) to push a live-preview snapshot; tool events still flush on the next loop. Cardkit
 *  allows 10 QPS per card entity (50 per app), but one snapshot a second reads smoothly (the client
 *  animates between snapshots).
 *  Doubles as the answer-preview aging window (see answerView). */
const STREAM_THROTTLE_MS = 1000;

/** Max length of a tool's arg preview in the live view. */
const TOOL_ARG_MAX = 48;

/** How much of the (growing) reasoning to peek at in the live view — the most recent tail. */
const THINKING_PREVIEW = 280;

/** The placeholder shown before any reasoning/tool/text arrives. */
const THINKING_PLACEHOLDER = "💭 Thinking…";

/** One-line, truncated: collapse whitespace so a multi-line command/arg stays on one line. */
function clip(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > TOOL_ARG_MAX ? `${one.slice(0, TOOL_ARG_MAX - 1)}…` : one;
}

/**
 * A compact, human-readable preview of a tool call's args so the live view reads `🔧 read AGENTS.md`
 * rather than just `🔧 read`. Generic (the channel knows no tool schemas): show the salient value — the
 * first primitive field, conventionally the subject (path / command / query / url) — else compact JSON.
 */
function summarizeArgs(args: Json): string {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return clip(String(args));
  const values = Object.values(args);
  const primary = values.find((v) => typeof v === "string" || typeof v === "number");
  if (primary !== undefined) return clip(String(primary));
  return values.length > 0 ? clip(JSON.stringify(args)) : "";
}

/** Cap a live view to the card budget, PREFIX-STABLE: the streaming client animates only when the old
 *  text is a prefix of the new, so an over-budget view freezes at its head rather than sliding a tail
 *  window (which would redraw the whole card every frame). The full answer still lands at settle. */
function capBytes(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(s.slice(0, mid), "utf8") <= maxBytes - 2) lo = mid;
    else hi = mid - 1;
  }
  return `${s.slice(0, lo)}…`;
}

/** The mounted preview, whichever tier setup reached. */
type Preview =
  | { kind: "card"; cardId: string; messageId: string }
  | { kind: "text"; messageId: string }
  | { kind: "none" }; // nothing mounted (setup failed entirely) — terminal writes send fresh

/**
 * The terminal-write POLICY: resolve the preview into `text`. One card → settle it in place (final
 * markdown, streaming off); an over-budget answer settles the card with its first chunk and sends the
 * rest as follow-up messages. A failed settle falls back to delete + fresh send, so no "Thinking…" card
 * is left pinned above the answer. Text tier → ONE edit into the final text (or delete + fresh sends
 * when it doesn't fit). No preview → fresh send. EMPTY text = "say nothing" → just delete the preview.
 */
async function finalize(
  api: LarkApi,
  target: LarkTarget,
  preview: Preview,
  text: string,
  seq: () => number,
): Promise<void> {
  if (text.trim() === "") {
    if (preview.kind !== "none") await api.deleteMessage(preview.messageId).catch(() => {});
    return;
  }
  if (preview.kind === "card") {
    const [head, ...rest] = chunkLarkText(text, CARD_MARKDOWN_MAX_BYTES);
    try {
      await api.updateCard(preview.cardId, finalCardJson(head ?? ""), seq());
      for (const chunk of rest) await api.sendText({ chatId: target.chatId }, chunk);
      return;
    } catch {
      // Settle failed (card expired / rejected) — fall through to delete + fresh send below.
    }
  }
  if (preview.kind === "text") {
    if (chunkLarkText(text).length === 1) {
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
 * Consume one turn's event stream into a Lark chat, live (see the module header for the preview
 * model). Preview updates are best-effort (logged once if they fail); the final write is authoritative
 * and surfaces a real failure (bad credentials, etc.). `noticeId` is the "⏳ queued" text notice sent
 * while this turn waited — it cannot morph into a card, so it is deleted once the preview is mounted
 * (and by the terminal write otherwise), never left pinned above the answer.
 */
export async function streamLarkReply(
  events: AsyncIterable<AgentEvent>,
  api: LarkApi,
  target: LarkTarget,
  formatError: (failed: LarkFailure) => string | undefined,
  noticeId?: string,
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
    return `💭 ${t.length > THINKING_PREVIEW ? `…${t.slice(t.length - THINKING_PREVIEW + 1)}` : t}`;
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

  // The live preview: ONE streaming card, mounted once (setup below), then snapshot-updated in place.
  // `sequence` must increase strictly per card — the single-writer pump guarantees it by construction.
  let preview: Preview = { kind: "none" };
  let setupAttempted = false;
  let sequence = 0;
  const nextSeq = (): number => ++sequence;
  let streamDead = false; // the platform closed streaming (idle timeout) — freeze the live view
  let finalized = false; // a terminal write (completed/failed) ran — the finally skips its orphan cleanup
  let lastSent = "";

  // The queue notice cannot be taken over (text vs card) — delete it once anything else is visible.
  let noticePending = noticeId !== undefined;
  const clearNotice = (): void => {
    if (!noticePending) return;
    noticePending = false;
    if (noticeId !== undefined) void api.deleteMessage(noticeId).catch(() => {});
  };

  /** Mount the preview ONCE: streaming card, or the text placeholder when the card tier fails. */
  const mountPreview = async (initial: string): Promise<void> => {
    setupAttempted = true;
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
            `[lark] mount rejected the fresh card (card=${cardId}, attempt ${attempt}) — retrying: ${String(e)}`,
          );
          await sleep(attempt * 400);
        }
      }
      if (messageId === undefined) throw new Error("interactive send returned ok without a message_id");
      preview = { kind: "card", cardId, messageId };
    } catch (e) {
      // Card tier failed — degrade to a text placeholder with NO live updates (the text tier's 20-edit
      // cap is spent on terminal writes only). Visible: the operator learns why the preview is static.
      log.warn(`[lark] streaming card unavailable — live preview degrades to a static placeholder: ${String(e)}`);
      const messageId =
        target.replyTo !== undefined
          ? await api.replyMessage(target.replyTo, "text", JSON.stringify({ text: THINKING_PLACEHOLDER }), {
              replyInThread: target.replyInThread,
            })
          : await api.sendMessage(target.chatId, "text", JSON.stringify({ text: THINKING_PLACEHOLDER }));
      preview = messageId !== undefined ? { kind: "text", messageId } : { kind: "none" };
    }
    clearNotice();
  };

  const flushPreview = async (): Promise<void> => {
    const text = view();
    if (!setupAttempted) {
      await mountPreview(text);
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
        log.warn("[lark] card streaming closed mid-turn — preview frozen; the final answer still lands");
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
            log.warn(`[lark] live preview failed (final reply still sends): ${String(e)}`);
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

  /** Terminal write + notice cleanup (whatever tier the preview reached). */
  const settle = async (text: string): Promise<void> => {
    clearNotice();
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
        const arg = summarizeArgs(e.args);
        toolIndexById.set(e.id, tools.length);
        tools.push({ label: arg ? `${e.name} ${arg}` : e.name, status: "running" });
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
          await settle(msg).catch(() => {});
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
      await settle(notice).catch(() => {});
    }
  }
}
