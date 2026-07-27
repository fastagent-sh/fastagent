/** Slack reply rendering: native Agent streams first, rate-safe edited-message compatibility second. */
import type { AgentEvent, Json } from "../../agent.ts";
import { log } from "../../log.ts";
import {
  RETRY_NOTICE,
  THINKING_PLACEHOLDER,
  type ChannelFailure,
  applyTurnEvent,
  composeTurnBody,
  createTurnView,
  defaultErrorMessage,
  humanizeToolName,
  revealedAnswer,
  summarizeToolArgs,
  toolLines,
} from "../preview-kit.ts";
import {
  type SlackApi,
  type SlackTarget,
  chunkSlackMarkdown,
  chunkSlackText,
  isSlackNativeUnavailable,
} from "./slack-api.ts";

export type SlackFailure = ChannelFailure;
export type SlackRendering = "native" | "classic";
export { defaultErrorMessage };

const CLASSIC_UPDATE_INTERVAL_MS = 3_000;
const NATIVE_APPEND_INTERVAL_MS = 750;
const WORKING_STATUS = "is working on your request…";
const GENERIC_FAILURE = "⚠️ The response stream stopped unexpectedly. Please try again.";

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** LLM output uses standard Markdown, never Slack's notification control syntax. Keep explicit sends in
 * the slack-send tool, where the Agent has to choose a side-effecting delivery action deliberately.
 * The inner class excludes BOTH `<` and `>` on purpose: bounding each run by the next delimiter keeps
 * the scan linear even on adversarial input like `(<!)^n` (a `>`-only bound would still be polynomial
 * across the many `<` start positions), while still neutralizing every `<@…>` / `<!…>` control sequence
 * (real Slack controls never contain a `<`). */
export function sanitizeSlackMarkdown(markdown: string): string {
  return markdown.replace(/<[@!][^<>]*>/g, (control) => `&lt;${control.slice(1)}`);
}

interface NativeToolTrace {
  label: string;
  operation?: string;
}

/** Render untrusted tool names/arguments as one standard-Markdown code span. A fence longer than any
 * backtick run in the value keeps the span balanced without changing the factual text. */
function inlineCode(value: string): string {
  const longest = Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const content = value.startsWith("`") || value.endsWith("`") ? ` ${value} ` : value;
  return `${fence}${content}${fence}`;
}

function nativeToolTrace(name: string, args: Json): NativeToolTrace {
  const operation = sanitizeSlackMarkdown(summarizeToolArgs(args));
  return {
    label: sanitizeSlackMarkdown(humanizeToolName(name)),
    ...(operation ? { operation } : {}),
  };
}

/** Bold a factual label. `humanizeToolName` normalizes `_` away for every ordinary identifier, but it
 * falls back to the raw name when normalization empties it (a tool literally named `_`), so emphasis
 * characters are escaped rather than assumed absent. */
function boldText(value: string): string {
  return `**${value.replace(/[\\*_]/g, "\\$&")}**`;
}

/**
 * One trace line: the tool, what it was called on, and — on the failure line — that it failed.
 *
 * Tool OUTPUT never leaves the process, failed or not: the channel would have to guess the engine's
 * result shape to read it, and the agent already explains a failure it recovered from in its answer.
 * The failure line therefore repeats the operation instead of adding one: it states WHICH call failed
 * (six `Bash` calls in a turn are otherwise indistinguishable) without exposing anything the start
 * line did not already show. Operators get the detail from the logs.
 */
function nativeToolLine(trace: NativeToolTrace, outcome = ""): string {
  return `${boldText(trace.label)}${outcome}${trace.operation ? ` — ${inlineCode(trace.operation)}` : ""}`;
}

function withDisclaimer(markdown: string, disclaimer: string | false | undefined): string {
  const body = markdown.trim() || "(no reply)";
  return disclaimer === false || !disclaimer?.trim() ? body : `${body}\n\n_${disclaimer.trim()}_`;
}

async function settleClassic(
  api: SlackApi,
  target: SlackTarget,
  previewTs: string | undefined,
  markdown: string,
  update: (ts: string, value: string) => Promise<void> = (ts, value) => api.updateMarkdown(target.channelId, ts, value),
): Promise<void> {
  if (markdown.trim() === "") {
    if (previewTs) await api.deleteMessage(target.channelId, previewTs).catch(() => {});
    return;
  }
  const [head, ...rest] = chunkSlackMarkdown(markdown);
  if (previewTs && head !== undefined) {
    try {
      await update(previewTs, head);
    } catch {
      await api.deleteMessage(target.channelId, previewTs).catch(() => {});
      await api.sendMarkdown(target, markdown);
      return;
    }
    // The updated preview is authoritative. Never resend it if a continuation fails: that would
    // duplicate any continuation that Slack already accepted.
    for (const chunk of rest) await api.postMarkdown(target, chunk);
    return;
  }
  await api.sendMarkdown(target, markdown);
}

/** Settle a queue/drop/defer notice. These are authored plain strings, so the basic text API is enough. */
export async function settleSlackPreview(
  api: SlackApi,
  target: SlackTarget,
  previewTs: string | undefined,
  text: string,
): Promise<void> {
  if (previewTs) {
    await api.updateMessage(target.channelId, previewTs, text);
    return;
  }
  await api.postMessage(target, text);
}

async function streamClassicSlackReply(
  events: AsyncIterable<AgentEvent>,
  api: SlackApi,
  target: SlackTarget,
  formatError: (failure: SlackFailure) => string | undefined,
  initialPreviewTs: string | undefined,
  disclaimer: string | false | undefined,
  label: string,
): Promise<void> {
  // Event → view-state reduction is the shared machine (preview-kit); this renderer owns mrkdwn
  // sanitizing and delivery. Reasoning stays a static "Thinking…" here: raw chain-of-thought is not
  // customer-facing on Slack, so the reducer accumulates it but this view never reads it.
  const turn = createTurnView();
  let previewTs = initialPreviewTs;
  let previewAttempted = previewTs !== undefined;
  let finalized = false;
  let lastMutationAt = previewTs ? Date.now() : 0;
  let lastSent = "";
  let dirty = false;
  let pumping = false;
  let stopped = false;
  let pumpDone: Promise<void> | undefined;
  let previewErrorLogged = false;

  const view = (): string =>
    composeTurnBody([
      THINKING_PLACEHOLDER,
      toolLines(turn),
      turn.retrying ? RETRY_NOTICE : "",
      sanitizeSlackMarkdown(revealedAnswer(turn, CLASSIC_UPDATE_INTERVAL_MS)),
    ]);
  const waitForMutationSlot = async (): Promise<void> => {
    const remaining = lastMutationAt + CLASSIC_UPDATE_INTERVAL_MS - Date.now();
    if (remaining > 0) await wait(remaining);
  };
  const updateRateSafe = async (ts: string, markdown: string): Promise<void> => {
    await waitForMutationSlot();
    await api.updateMarkdown(target.channelId, ts, markdown);
    lastMutationAt = Date.now();
  };
  const flushPreview = async (): Promise<void> => {
    const markdown = chunkSlackText(view())[0] ?? THINKING_PLACEHOLDER;
    if (markdown === lastSent) return;
    if (previewTs) {
      await updateRateSafe(previewTs, markdown);
    } else {
      if (previewAttempted) return;
      previewAttempted = true;
      previewTs = await api.postMarkdown(target, markdown);
      lastMutationAt = Date.now();
    }
    lastSent = markdown;
  };
  const runPump = async (): Promise<void> => {
    pumping = true;
    try {
      while (dirty && !stopped) {
        dirty = false;
        try {
          await flushPreview();
        } catch (error) {
          if (!previewErrorLogged) {
            previewErrorLogged = true;
            log.warn(`${label} live preview failed (final reply still sends): ${String(error)}`);
          }
        }
      }
    } finally {
      pumping = false;
    }
  };
  const touch = (): void => {
    dirty = true;
    if (!pumping) pumpDone = runPump();
  };
  const finishPump = async (): Promise<void> => {
    stopped = true;
    await pumpDone?.catch(() => {});
  };
  const finalize = async (markdown: string): Promise<void> => {
    await settleClassic(api, target, previewTs, sanitizeSlackMarkdown(markdown), updateRateSafe);
  };

  try {
    for await (const event of events) {
      if (event.type === "completed") {
        await finishPump();
        finalized = true;
        await finalize(withDisclaimer(turn.answer, disclaimer));
        return;
      }
      if (event.type === "failed") {
        await finishPump();
        finalized = true;
        const notice = formatError({ details: event.details, retryable: event.retryable }) ?? "";
        await finalize(notice).catch((error) =>
          log.error(`${label} failed to deliver the agent-failure notice: ${String(error)}`),
        );
        throw new Error(`agent failed: ${event.details} (retryable=${event.retryable})`);
      }
      const changed = applyTurnEvent(turn, event);
      // A young (hidden) answer must not trigger the first frame: unlike telegram/feishu, classic
      // rendering never posts an upfront placeholder, so a text-only fast turn delivers ONE final
      // post instead of placeholder → 3s-rate-limited edit. Thinking/tool activity still paints.
      if (changed && (event.type !== "text" || revealedAnswer(turn, CLASSIC_UPDATE_INTERVAL_MS) !== "")) touch();
    }
    throw new Error("stream ended without a terminal event");
  } finally {
    await finishPump();
    if (!finalized) {
      const notice = formatError({ details: "the turn ended without completing", retryable: false }) ?? "";
      await finalize(notice).catch((error) =>
        log.error(`${label} failed to deliver the abnormal-turn notice: ${String(error)}`),
      );
    }
  }
}

async function streamNativeSlackReply(
  events: AsyncIterable<AgentEvent>,
  api: SlackApi,
  target: SlackTarget,
  formatError: (failure: SlackFailure) => string | undefined,
  initialPreviewTs: string | undefined,
  threadTitle: string | undefined,
  disclaimer: string | false | undefined,
  label: string,
): Promise<void> {
  if (initialPreviewTs) {
    await api
      .deleteMessage(target.channelId, initialPreviewTs)
      .catch((error) =>
        log.warn(`${label} could not remove the compatibility queue notice before native streaming: ${String(error)}`),
      );
  }
  if (target.channelId.startsWith("D")) {
    await Promise.all([
      api
        .setThreadStatus(target, WORKING_STATUS)
        .catch((error) => log.warn(`${label} could not set Slack Agent status: ${String(error)}`)),
      threadTitle
        ? api
            .setThreadTitle(target, threadTitle)
            .catch((error) => log.warn(`${label} could not set Slack Agent thread title: ${String(error)}`))
        : Promise.resolve(),
    ]);
  }

  let streamTs: string | undefined;
  let retryStatusShown = false;
  // DM Agent-status writes are fire-and-forget for the render loop, but must reach Slack in order:
  // an out-of-order pair would leave a stale "retrying" line after progress (or after the final
  // clear). One promise chain serializes them; each link swallows its own delivery error.
  let statusChain = Promise.resolve();
  const setStatus = (status: string): void => {
    statusChain = statusChain.then(() =>
      api
        .setThreadStatus(target, status)
        .catch((error) => log.warn(`${label} could not set Slack Agent status: ${String(error)}`)),
    );
  };
  const toolTraces = new Map<string, NativeToolTrace>();
  let pendingText = "";
  let fullAnswer = "";
  let textTimer: ReturnType<typeof setTimeout> | undefined;
  let lastTextFlushAt = 0;
  let operation = Promise.resolve();
  let renderError: unknown;
  let finalized = false;
  let streamHasContent = false;
  let streamEndsWithBlankLine = false;

  const enqueue = (work: () => Promise<void>): void => {
    operation = operation.then(async () => {
      if (renderError !== undefined) return;
      try {
        await work();
      } catch (error) {
        renderError = error;
      }
    });
  };
  const sendContent = async (markdown: string): Promise<void> => {
    if (streamTs) {
      await api.appendStream(target.channelId, streamTs, markdown);
    } else {
      streamTs = await api.startStream(target, markdown);
    }
  };
  const queueMarkdown = (markdown: string): void => {
    if (!markdown) return;
    streamHasContent = true;
    streamEndsWithBlankLine = markdown.endsWith("\n\n");
    enqueue(() => sendContent(markdown));
  };
  const flushText = (final = false): void => {
    if (textTimer) {
      clearTimeout(textTimer);
      textTimer = undefined;
    }
    let value = pendingText;
    pendingText = "";
    if (!final) {
      // Hold a possible Slack control token split across Agent deltas/flush windows until its closing
      // `>` arrives. This prevents `<` + `!channel>` from bypassing the sanitizer.
      const open = value.lastIndexOf("<");
      if (open >= 0 && !value.slice(open).includes(">") && value.length - open <= 256) {
        pendingText = value.slice(open);
        value = value.slice(0, open);
      }
    }
    if (!value) return;
    lastTextFlushAt = Date.now();
    for (const chunk of chunkSlackText(sanitizeSlackMarkdown(value))) queueMarkdown(chunk);
  };
  const scheduleText = (): void => {
    if (textTimer) return;
    const delay = Math.max(0, lastTextFlushAt + NATIVE_APPEND_INTERVAL_MS - Date.now());
    textTimer = setTimeout(() => {
      textTimer = undefined;
      flushText();
    }, delay);
  };
  // ponytail: a trace appended while the answer has an unclosed ``` fence lands inside it, and the
  // trace's own backticks can close it early. Tracking fence parity across chunk boundaries (the job
  // chunkSlackMarkdown does for the classic renderer) is the fix if a model is ever seen calling a
  // tool mid-fence; the trace's blank-line framing keeps every other case well-formed.
  const sendToolTrace = (line: string): void => {
    flushText();
    const separator = streamHasContent && !streamEndsWithBlankLine ? "\n\n" : "";
    queueMarkdown(`${separator}${line}\n\n`);
  };
  const settleNative = async (terminalMarkdown: string): Promise<void> => {
    flushText(true);
    await operation;
    const safeTerminal = sanitizeSlackMarkdown(terminalMarkdown);
    if (renderError !== undefined) {
      if (!streamTs && isSlackNativeUnavailable(renderError)) {
        log.warn(`${label} native Slack stream was unavailable; delivering one compatibility Markdown reply`);
        await api.sendMarkdown(target, safeTerminal);
        return;
      }
      if (streamTs) {
        await api.stopStream(target.channelId, streamTs, `\n\n${GENERIC_FAILURE}`).catch(() => {});
      }
      throw renderError;
    }
    if (!streamTs) streamTs = await api.startStream(target, safeTerminal);
    await api.stopStream(target.channelId, streamTs);
  };

  try {
    for await (const event of events) {
      if (event.type !== "retrying" && retryStatusShown) {
        // Progress after a retry notice: restore the normal working status so the stale line doesn't
        // contradict a visibly streaming answer.
        retryStatusShown = false;
        setStatus(WORKING_STATUS);
      }
      if (event.type === "text") {
        pendingText += event.delta;
        fullAnswer += event.delta;
        scheduleText();
      } else if (event.type === "thinking") {
        // Slack's native loading status represents private reasoning without exposing it.
      } else if (event.type === "retrying") {
        // A summarization retry backoff pauses the stream (~14s worst case). Channels have no per-run
        // status surface in native mode; DMs get the explicit Agent status line, restored on progress.
        if (target.channelId.startsWith("D")) {
          retryStatusShown = true;
          setStatus("hit a temporary problem — retrying…");
        }
      } else if (event.type === "tool_started") {
        const trace = nativeToolTrace(event.name, event.args);
        toolTraces.set(event.id, trace);
        sendToolTrace(nativeToolLine(trace));
      } else if (event.type === "tool_ended") {
        const trace = toolTraces.get(event.id) ?? { label: "Tool" };
        toolTraces.delete(event.id);
        if (event.isError) sendToolTrace(nativeToolLine(trace, " failed"));
      } else if (event.type === "completed") {
        finalized = true;
        const finalAnswer = withDisclaimer(fullAnswer, disclaimer);
        const footer = finalAnswer.slice(fullAnswer.trim().length);
        if (footer) pendingText += footer;
        await settleNative(finalAnswer);
        return;
      } else if (event.type === "failed") {
        finalized = true;
        const notice = formatError({ details: event.details, retryable: event.retryable }) ?? "";
        if (notice) {
          pendingText += `${fullAnswer.trim() ? "\n\n" : ""}${notice}`;
          fullAnswer += `${fullAnswer.trim() ? "\n\n" : ""}${notice}`;
        }
        await settleNative(fullAnswer.trim() || GENERIC_FAILURE).catch((error) =>
          log.error(`${label} failed to deliver the agent-failure stream: ${String(error)}`),
        );
        throw new Error(`agent failed: ${event.details} (retryable=${event.retryable})`);
      }
    }
    throw new Error("stream ended without a terminal event");
  } finally {
    if (textTimer) clearTimeout(textTimer);
    if (!finalized) {
      pendingText += `${fullAnswer.trim() ? "\n\n" : ""}${GENERIC_FAILURE}`;
      await settleNative(fullAnswer.trim() || GENERIC_FAILURE).catch((error) =>
        log.error(`${label} failed to stop an abnormal Slack stream: ${String(error)}`),
      );
    }
    if (target.channelId.startsWith("D")) {
      setStatus("");
      await statusChain;
    }
  }
}

export async function streamSlackReply(
  events: AsyncIterable<AgentEvent>,
  api: SlackApi,
  target: SlackTarget,
  formatError: (failure: SlackFailure) => string | undefined,
  options: {
    rendering?: SlackRendering;
    initialPreviewTs?: string;
    threadTitle?: string;
    disclaimer?: string | false;
    label?: string;
  } = {},
): Promise<void> {
  const { rendering = "native", initialPreviewTs, threadTitle, disclaimer, label = "[slack]" } = options;
  if (rendering === "native" && target.threadTs) {
    return streamNativeSlackReply(events, api, target, formatError, initialPreviewTs, threadTitle, disclaimer, label);
  }
  if (rendering === "native") {
    log.info(`${label} native streaming needs a thread target — using the classic renderer for this turn`);
  }
  return streamClassicSlackReply(events, api, target, formatError, initialPreviewTs, disclaimer, label);
}
