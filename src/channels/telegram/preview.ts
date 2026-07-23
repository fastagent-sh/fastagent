/**
 * Live-preview rendering: consume one turn's event stream into a Telegram chat. A single real message
 * is sent once ("💭 Thinking…", or an already-sent "⏳ queued" notice is taken over), then
 * editMessageText'd in place with the latest tool calls + partial text (PLAIN — a partial answer may
 * carry unbalanced HTML); on completion the same message is edited into the final answer as HTML. One
 * message, works in groups and private (unlike sendMessageDraft, which is private/forum-topic only).
 */
import type { AgentEvent } from "../../agent.ts";
import { RETRY_NOTICE, type ChannelFailure, defaultErrorMessage, summarizeToolArgs } from "../preview-kit.ts";
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
 * The terminal-write POLICY: resolve the single preview message into `text`. streamReply owns the
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
export async function streamReply(
  events: AsyncIterable<AgentEvent>,
  api: string,
  botToken: string,
  target: Target,
  formatError: (failed: TelegramFailure) => string | undefined,
  previewId?: number,
): Promise<void> {
  const tools: { label: string; status: "running" | "ok" | "error" }[] = [];
  const toolIndexById = new Map<string, number>();
  let thinking = "";
  let answer = "";
  let answerPreviewSince: number | undefined;
  let retryNotice = false;

  const mark = { running: "…", ok: "✓", error: "✗" } as const;
  const toolView = (): string => tools.map((t) => `🔧 ${t.label} ${mark[t.status]}`).join("\n");
  // Reasoning is process, not the answer: shown (capped to its tail) in the live preview only, never
  // in the persisted final message (which is `answer` alone).
  const thinkingView = (): string => {
    const t = thinking.replace(/\s+/g, " ").trim();
    if (t === "") return "";
    return `💭 ${t.length > THINKING_PREVIEW ? `…${t.slice(t.length - THINKING_PREVIEW + 1)}` : t}`;
  };
  // The answer is hidden until its first delta has aged one EDIT_THROTTLE_MS: the pump's leading-edge
  // flush would otherwise turn the very first content delta (often a lone character or unbalanced markup)
  // into its own Telegram edit — the short-reply flicker (placeholder → "O" → "OK."). Aging is anchored
  // at delta ARRIVAL (set in the event loop, not here) so an in-flight edit can't skew the clock, and
  // there is deliberately NO timer at the boundary: a young answer surfaces on the next content-driven
  // preview pass, so a turn completing within the window sends the final answer edit only.
  const answerView = (): string => {
    if (answer.trim() === "" || answerPreviewSince === undefined) return "";
    return Date.now() - answerPreviewSince >= EDIT_THROTTLE_MS ? answer : "";
  };
  const view = (): string => {
    const v = [thinkingView(), toolView(), retryNotice ? RETRY_NOTICE : "", answerView()]
      .filter((s) => s.trim() !== "")
      .join("\n\n")
      .trim();
    // Before any reasoning/tool/text arrives, show an explicit placeholder rather than an empty edit.
    return v === "" ? "💭 Thinking…" : v;
  };

  // The live preview is ONE real message: sent once (capturing its id + threading under the asker),
  // then edited in place. messageId/lastSent are shared with the final write on completion.
  // `previewId`: an already-sent message to take over as the preview (the "⏳ queued" notice) — the
  // pump edits it in place, so the queue notice morphs into the live view instead of leaving an orphan.
  let messageId: number | undefined = previewId;
  let previewSent = messageId !== undefined; // a placeholder send was attempted — guards against re-sending when no id came back
  let finalized = false; // a terminal write (completed/failed) ran — the finally skips its orphan cleanup
  let lastSent = "";
  const flushPreview = async (): Promise<void> => {
    const text = view();
    if (text === lastSent) return; // skip an unchanged edit (Telegram rejects "message is not modified")
    lastSent = text;
    if (messageId !== undefined) {
      await editMessageText(api, botToken, target, messageId, text); // plain — a partial answer may carry unbalanced HTML
      return;
    }
    // No preview message yet. Send the placeholder ONCE; never re-send (that would spam a new message per
    // frame). If Telegram returns ok WITHOUT a message_id (proxy / odd API base / unparseable body) we
    // cannot edit — fail visibly and stop previewing (the final write still lands via finalize).
    if (previewSent) return;
    previewSent = true;
    messageId = await sendMessage(api, botToken, target, text, { html: false });
    if (messageId === undefined)
      throw new Error("telegram sendMessage returned ok without a message_id — live preview disabled for this turn");
  };

  // ── Live-preview pump: a SINGLE serialized writer. ──────────────────────────────────────────
  // Events mutate state (thinking / tools / answer) and mark the preview dirty; the pump edits the
  // message to the LATEST view() with at most ONE edit in flight, paced by a throttle. One-in-flight is
  // the whole point: concurrent edits can reach Telegram out of order — an older frame landing over a
  // newer one is the "shows 3-4 steps, blanks, re-fills" flicker. Serializing keeps frames monotonic.
  // (No keepalive: a real message does not expire, unlike a Bot API `sendMessageDraft` (30s window).)
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
          // Best-effort preview (the final write is authoritative), but a failing edit must be visible —
          // log once per turn so a never-rendering preview is diagnosable, not silent.
          if (!previewErrLogged) {
            previewErrLogged = true;
            log.warn(`[telegram] live preview failed (final reply still sends): ${String(e)}`);
          }
        }
        if (dirty && !stopped) {
          // Pace + coalesce a burst into one edit. Interruptible: finish() cuts this short so the final
          // write is not delayed by up to EDIT_THROTTLE_MS after the turn completes.
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, EDIT_THROTTLE_MS);
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
  // Mark the preview dirty and ensure the single writer is running (an edit already in flight picks up
  // the new state on its next loop). Synchronous — callers never await a network write.
  const touch = (): void => {
    dirty = true;
    if (!pumping) pumpDone = runPump();
  };

  touch(); // send the "💭 Thinking…" placeholder immediately

  // Stop the pump and await any in-flight edit, so the final write below is strictly the LAST one to the
  // preview message (no stale frame landing after the answer).
  const finish = async (): Promise<void> => {
    stopped = true;
    wakeThrottle?.(); // cut an in-flight throttle so the final write is not delayed up to EDIT_THROTTLE_MS
    await pumpDone?.catch(() => {});
  };

  try {
    for await (const e of events) {
      if (e.type !== "retrying") retryNotice = false; // any progress closes the advisory backoff notice
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
        tools.push({ label: arg ? `${e.name} ${arg}` : e.name, status: "running" });
        touch();
      } else if (e.type === "tool_ended") {
        const i = toolIndexById.get(e.id);
        const t = i === undefined ? undefined : tools[i];
        if (t) t.status = e.isError ? "error" : "ok";
        touch();
      } else if (e.type === "retrying") {
        // Summarization retry backoff — up to ~14s of quiet that would otherwise read as a hang.
        retryNotice = true;
        touch();
      } else if (e.type === "completed") {
        await finish();
        // Edit the preview into the final answer (HTML, plain fallback); the persisted message is the
        // answer alone — the process (thinking/tools) was preview-only. Mark finalized BEFORE delivering:
        // the terminal was reached, so a delivery failure here is a plain failure, not an "abnormal exit"
        // (which would wrongly fire the finally's neutral-notice fallback = double delivery + wrong text).
        finalized = true;
        await finalize(api, botToken, target, messageId, answer.trim() !== "" ? answer : "(no reply)");
        return;
      } else if (e.type === "failed") {
        await finish();
        // Two audiences: the chat (customer-facing — formatError, neutral by default) and the operator
        // log (dev-facing — the full details, via the throw below + the handler's catch). Same terminal
        // write as completed: edit → fresh-send if the preview is gone; an empty notice deletes the
        // placeholder (suppress = no residue). HTML like the answer — symmetric, and finalize already
        // falls back to plain if a custom onError returns markup Telegram rejects. Best-effort — we throw
        // below regardless.
        finalized = true;
        {
          const msg = formatError({ details: e.details, retryable: e.retryable }) ?? "";
          await finalize(api, botToken, target, messageId, msg).catch(() => {});
        }
        throw new Error(`agent failed: ${e.details} (retryable=${e.retryable})`);
      }
    }
    throw new Error("stream ended without a terminal event"); // violates SPEC MUST 1
  } finally {
    await finish();
    // Abnormal exit (stream ended without a terminal, the generator threw, or the consumer abandoned): no
    // terminal write ran. Show the SAME neutral notice a `failed` event would — the preview may show real
    // partial work, so don't delete it silently, and don't leave the user in silence. A suppressing
    // onError still collapses to a delete (finalize on empty text).
    if (!finalized) {
      // retryable:false — an abnormal end (no terminal / a throw) is of UNKNOWN retryability, so use the
      // neutral "something went wrong" default rather than promising "try again" that may not help.
      const notice = formatError({ details: "the turn ended without completing", retryable: false }) ?? "";
      // finalize handles messageId===undefined (no preview reached) with a fresh send — so the user is
      // told even when the turn died before any message.
      await finalize(api, botToken, target, messageId, notice).catch(() => {});
    }
  }
}
