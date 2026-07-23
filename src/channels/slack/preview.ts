/** Slack reply rendering: native Agent streams first, rate-safe edited-message compatibility second. */
import type { AgentEvent } from "../../agent.ts";
import { log } from "../../log.ts";
import { RETRY_NOTICE, type ChannelFailure, defaultErrorMessage, humanizeToolName } from "../preview-kit.ts";
import {
  type SlackApi,
  type SlackStreamChunk,
  type SlackTarget,
  type SlackTaskDisplayMode,
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
  const tools: { name: string; status: "running" | "ok" | "error" }[] = [];
  const toolIndex = new Map<string, number>();
  let answer = "";
  let retryNotice = false;
  let answerVisible = false;
  let answerTimer: ReturnType<typeof setTimeout> | undefined;
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

  const toolView = (): string =>
    tools.map((tool) => `🔧 ${tool.name} ${{ running: "…", ok: "✓", error: "✗" }[tool.status]}`).join("\n");
  const view = (): string =>
    ["💭 Thinking…", toolView(), retryNotice ? RETRY_NOTICE : "", answerVisible ? sanitizeSlackMarkdown(answer) : ""]
      .filter((value) => value.trim())
      .join("\n\n")
      .trim();
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
    const markdown = chunkSlackText(view())[0] ?? "💭 Thinking…";
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
    if (answerTimer) clearTimeout(answerTimer);
    await pumpDone?.catch(() => {});
  };
  const finalize = async (markdown: string): Promise<void> => {
    await settleClassic(api, target, previewTs, sanitizeSlackMarkdown(markdown), updateRateSafe);
  };

  try {
    for await (const event of events) {
      if (event.type !== "retrying") retryNotice = false; // any progress closes the advisory backoff notice
      if (event.type === "text") {
        answer += event.delta;
        if (!answerVisible && answerTimer === undefined) {
          answerTimer = setTimeout(() => {
            answerVisible = true;
            answerTimer = undefined;
            touch();
          }, CLASSIC_UPDATE_INTERVAL_MS);
        } else if (answerVisible) {
          touch();
        }
      } else if (event.type === "thinking") {
        // Raw model reasoning is not customer-facing. A static loading state communicates progress
        // without leaking chain-of-thought or prompt data.
        touch();
      } else if (event.type === "tool_started") {
        toolIndex.set(event.id, tools.length);
        tools.push({ name: humanizeToolName(event.name), status: "running" });
        touch();
      } else if (event.type === "tool_ended") {
        const index = toolIndex.get(event.id);
        if (index !== undefined && tools[index]) tools[index].status = event.isError ? "error" : "ok";
        touch();
      } else if (event.type === "retrying") {
        // Summarization retry backoff — up to ~14s of quiet that would otherwise read as a hang.
        retryNotice = true;
        touch();
      } else if (event.type === "completed") {
        await finishPump();
        finalized = true;
        await finalize(withDisclaimer(answer, disclaimer));
        return;
      } else if (event.type === "failed") {
        await finishPump();
        finalized = true;
        const notice = formatError({ details: event.details, retryable: event.retryable }) ?? "";
        await finalize(notice).catch((error) =>
          log.error(`${label} failed to deliver the agent-failure notice: ${String(error)}`),
        );
        throw new Error(`agent failed: ${event.details} (retryable=${event.retryable})`);
      }
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
  taskDisplayMode: SlackTaskDisplayMode,
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
  const toolNames = new Map<string, string>();
  let pendingText = "";
  let fullAnswer = "";
  let textTimer: ReturnType<typeof setTimeout> | undefined;
  let lastTextFlushAt = 0;
  let operation = Promise.resolve();
  let renderError: unknown;
  let finalized = false;

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
  const sendContent = async (content: { markdownText?: string; chunks?: SlackStreamChunk[] }): Promise<void> => {
    if (streamTs) {
      await api.appendStream(target.channelId, streamTs, content);
    } else {
      streamTs = await api.startStream(target, content, taskDisplayMode);
    }
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
    for (const chunk of chunkSlackText(sanitizeSlackMarkdown(value))) {
      enqueue(() => sendContent({ markdownText: chunk }));
    }
  };
  const scheduleText = (): void => {
    if (textTimer) return;
    const delay = Math.max(0, lastTextFlushAt + NATIVE_APPEND_INTERVAL_MS - Date.now());
    textTimer = setTimeout(() => {
      textTimer = undefined;
      flushText();
    }, delay);
  };
  const sendTask = (chunk: SlackStreamChunk): void => {
    flushText();
    enqueue(() => sendContent({ chunks: [chunk] }));
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
        await api.stopStream(target.channelId, streamTs, { markdownText: `\n\n${GENERIC_FAILURE}` }).catch(() => {});
      }
      throw renderError;
    }
    if (!streamTs) streamTs = await api.startStream(target, { markdownText: safeTerminal }, taskDisplayMode);
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
        const title = humanizeToolName(event.name);
        toolNames.set(event.id, title);
        sendTask({ type: "task_update", id: event.id, title, status: "in_progress" });
      } else if (event.type === "tool_ended") {
        sendTask({
          type: "task_update",
          id: event.id,
          title: toolNames.get(event.id) ?? "Tool",
          status: event.isError ? "error" : "complete",
        });
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
    taskDisplay?: SlackTaskDisplayMode;
    label?: string;
  } = {},
): Promise<void> {
  const {
    rendering = "native",
    initialPreviewTs,
    threadTitle,
    disclaimer,
    taskDisplay = "plan",
    label = "[slack]",
  } = options;
  if (rendering === "native" && target.threadTs) {
    return streamNativeSlackReply(
      events,
      api,
      target,
      formatError,
      initialPreviewTs,
      threadTitle,
      disclaimer,
      label,
      taskDisplay,
    );
  }
  if (rendering === "native") {
    log.info(`${label} native streaming needs a thread target — using the classic renderer for this turn`);
  }
  return streamClassicSlackReply(events, api, target, formatError, initialPreviewTs, disclaimer, label);
}
