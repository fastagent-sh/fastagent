/**
 * Slack reply rendering, as Slack asks an agent to answer: a native stream (`chat.startStream`) in the reply's thread,
 * the agent session's status set around it (`agents.sessions.setStatus`). A stream is bounded (10 minutes, 12,000
 * characters), so a long answer continues in a new stream in the same thread. A reply with no thread (a custom route's
 * top-level target) cannot be streamed: it is posted once it is done.
 */
import type { Json } from "../../agent-api.ts";
import type { TurnEvent } from "../kit/invoke.ts";
import { answerText } from "../../answer-text.ts";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import type * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { PromiseFailure, joinPromise } from "../../promise-bridge.ts";
import { log } from "../../log.ts";
import {
  type ChannelFailure,
  applyTurnEvent,
  createTurnView,
  defaultErrorMessage,
  humanizeToolName,
  renderReply,
  serialWriter,
  summarizeToolArgs,
  turnEnd,
  unfinishedTurn,
} from "../kit/preview.ts";
import {
  type SlackApi,
  type SlackTarget,
  chunkSlackMarkdown,
  chunkSlackText,
  isSlackNativeUnavailable,
} from "./slack-api.ts";

export type SlackFailure = ChannelFailure;
export { defaultErrorMessage };

const NATIVE_APPEND_INTERVAL_MS = 750;
/** Slack finalizes a stream 10 minutes after it starts and refuses one past 12,000 characters: rotate before either. */
const STREAM_MAX_MS = 9 * 60_000;
const STREAM_MAX_CHARS = 12_000;
const GENERIC_FAILURE = "⚠️ The response stream stopped unexpectedly. Please try again.";

/** LLM output uses standard Markdown, never Slack's notification control syntax. Keep explicit sends in
 * the slack-send tool, where the Agent has to choose a side-effecting delivery action deliberately.
 * The inner class excludes BOTH `<` and `>` on purpose: bounding each run by the next delimiter keeps
 * the scan linear even on adversarial input like `(<!)^n` (a `>`-only bound would still be polynomial
 * across the many `<` start positions), while still neutralizing every `<@…>` / `<!…>` control sequence
 * (real Slack controls never contain a `<`). */
function sanitizeSlackMarkdown(markdown: string): string {
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
 * Tool OUTPUT never leaves the process, failed or not: the channel would have to guess the harness's
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

/** Post `markdown` as the reply, taking over `previewTs` (a notice this process posted) when there is one. */
async function settleMessage(
  api: SlackApi,
  target: SlackTarget,
  previewTs: string | undefined,
  markdown: string,
): Promise<void> {
  // Best-effort: the reply lands either way, but a preview left behind sits above it, so say so.
  const dropPreview = (ts: string) =>
    api
      .deleteMessage(target.channelId, ts)
      .catch((error) => log.warn(`[slack] could not delete the live preview ${ts}: ${String(error)}`));
  if (markdown.trim() === "") {
    if (previewTs) await dropPreview(previewTs);
    return;
  }
  const [head, ...rest] = chunkSlackMarkdown(markdown);
  if (previewTs && head !== undefined) {
    try {
      await api.updateMarkdown(target.channelId, previewTs, head);
    } catch (error) {
      log.warn(`[slack] final edit of the live preview failed (${String(error)}); sending the reply as a new message`);
      await dropPreview(previewTs);
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

/**
 * Deliver a reply this process did not generate: a recovered answer. The stream it was written for is gone with its
 * process, so there is none to resume — but a queue message THIS process posted while the record
 * waited its turn is taken over rather than left above the answer.
 */
export async function deliverSlackAnswer(
  api: SlackApi,
  target: SlackTarget,
  markdown: string,
  previewTs?: string,
): Promise<void> {
  await settleMessage(api, target, previewTs, sanitizeSlackMarkdown(markdown));
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

/** A reply with no thread to stream into: the answer is posted once the turn is done. */
function postSlackReply(
  events: Stream.Stream<TurnEvent, PromiseFailure>,
  api: SlackApi,
  target: SlackTarget,
  formatError: (failure: SlackFailure) => string | undefined,
  disclaimer: string | false | undefined,
  label: string,
  onAnswered?: (answer: string) => void,
) {
  return Effect.gen(function* () {
    const turn = createTurnView();
    yield* renderReply(events, {
      label,
      finish: Effect.void,
      formatError,
      answer: () => withDisclaimer(turn.answer, disclaimer),
      ...(onAnswered ? { onAnswered } : {}),
      settle: (markdown) => joinPromise(() => settleMessage(api, target, undefined, sanitizeSlackMarkdown(markdown))),
      onEvent: (event) => void applyTurnEvent(turn, event),
    });
  });
}

/**
 * The native renderer owns its own terminal branches instead of `renderReply`'s: each of its three
 * endings (completed, agent failure, abnormal) weaves the ending INTO the open stream — the notice
 * becomes more of the answer being typed out — where `renderReply` issues one separate settle write.
 * Sharing the loop would mean injecting all three, which is more shape than the two lines it saves.
 */
function streamNativeSlackReply(
  events: Stream.Stream<TurnEvent, PromiseFailure>,
  api: SlackApi,
  target: SlackTarget,
  formatError: (failure: SlackFailure) => string | undefined,
  threadTitle: string | undefined,
  disclaimer: string | false | undefined,
  label: string,
  onAnswered?: (answer: string) => void,
) {
  return Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const now = () => clock.currentTimeMillisUnsafe();
    const scope = yield* Effect.scope;
    const run = Effect.runSyncWith(yield* Effect.context<never>());
    let streamTs: string | undefined;
    /** When the open stream started, and how many characters it carries: what bounds it. */
    let streamStartedAt = 0;
    let streamChars = 0;
    const setStatus = (status: "processing" | "active", title?: string): Promise<void> =>
      api
        .setSessionStatus(target, status, title)
        .catch((error) => log.warn(`${label} could not set the Slack agent session ${status}: ${String(error)}`));
    // Ready for the next prompt, however the turn ended: a stream's stop says so too, but a turn may end before one.
    yield* Effect.addFinalizer(() => Effect.promise(() => setStatus("active")));
    let stopAttempted = false;
    const stop = (ts: string, markdown?: string): Promise<void> => {
      // A rejected stop may have landed; scope cleanup must not retry it.
      stopAttempted = true;
      return api.stopStream(target.channelId, ts, markdown);
    };
    yield* Effect.addFinalizer(() =>
      Effect.suspend(() => {
        const ts = streamTs;
        return ts && !stopAttempted
          ? joinPromise(() => stop(ts, `\n\n${GENERIC_FAILURE}`)).pipe(
              Effect.catchTag("PromiseFailure", (error) =>
                Effect.sync(() =>
                  log.error(`${label} failed to stop an abnormal Slack stream: ${String(error.cause)}`),
                ),
              ),
            )
          : Effect.void;
      }),
    );
    const toolTraces = new Map<string, NativeToolTrace>();
    let pendingText = "";
    let fullAnswer = "";
    let textTimer: Fiber.Fiber<void> | undefined;
    let lastTextFlushAt = 0;
    const operations = yield* serialWriter();
    let renderError: unknown;
    let finalized = false;
    let streamHasContent = false;
    let streamEndsWithBlankLine = false;

    const enqueue = (work: () => Promise<void>): void => {
      operations.enqueue(async () => {
        if (renderError !== undefined) return;
        try {
          await work();
        } catch (error) {
          renderError = error;
        }
      });
    };
    const sendContent = async (markdown: string): Promise<void> => {
      const chars = Array.from(markdown).length;
      if (streamTs && (streamChars + chars > STREAM_MAX_CHARS || now() - streamStartedAt >= STREAM_MAX_MS)) {
        // The answer goes on in a new message of the same thread; the session stays processing.
        await api.stopStream(target.channelId, streamTs, undefined, "processing");
        streamTs = undefined;
      }
      if (streamTs) {
        await api.appendStream(target.channelId, streamTs, markdown);
        streamChars += chars;
      } else {
        streamTs = await api.startStream(target, markdown);
        streamStartedAt = now();
        streamChars = chars;
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
        textTimer.interruptUnsafe();
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
      lastTextFlushAt = now();
      for (const chunk of chunkSlackText(sanitizeSlackMarkdown(value))) queueMarkdown(chunk);
    };
    const scheduleText = (): void => {
      // A zero-delay clock can finish before its handle is published.
      if (textTimer && !textTimer.pollUnsafe()) return;
      const delay = Math.max(0, lastTextFlushAt + NATIVE_APPEND_INTERVAL_MS - now());
      textTimer = run(
        Effect.forkIn(
          Effect.sleep(delay).pipe(
            Effect.andThen(
              Effect.sync(() => {
                textTimer = undefined;
                flushText();
              }),
            ),
          ),
          scope,
        ),
      );
    };
    // ponytail: a trace appended while the answer has an unclosed ``` fence lands inside it, and the
    // trace's own backticks can close it early. Tracking fence parity across chunk boundaries (the job
    // chunkSlackMarkdown does for a posted reply) is the fix if a model is ever seen calling a
    // tool mid-fence; the trace's blank-line framing keeps every other case well-formed.
    const sendToolTrace = (line: string): void => {
      flushText();
      const separator = streamHasContent && !streamEndsWithBlankLine ? "\n\n" : "";
      queueMarkdown(`${separator}${line}\n\n`);
    };
    const settleNative = (terminalMarkdown: string) =>
      Effect.gen(function* () {
        flushText(true);
        yield* operations.finish;
        yield* joinPromise(async () => {
          const safeTerminal = sanitizeSlackMarkdown(terminalMarkdown);
          if (renderError !== undefined) {
            if (!streamTs && isSlackNativeUnavailable(renderError)) {
              log.warn(`${label} native Slack stream was unavailable; posting the answer as one Markdown reply`);
              await api.sendMarkdown(target, safeTerminal);
              return;
            }
            if (streamTs) {
              await stop(streamTs, `\n\n${GENERIC_FAILURE}`).catch(() => {});
            }
            throw renderError;
          }
          if (!streamTs) streamTs = await api.startStream(target, safeTerminal);
          // What this settle had to say is on screen now — appended, or carried by the startStream above. `stop`
          // only closes the stream, so failing it must not report the turn as undelivered: that would re-send the
          // whole answer on the next start. The open stream is the visible cost, and the log is where it is
          // diagnosed. (Shared by all three endings, so the wording claims a terminal write, not an answer.)
          await stop(streamTs).catch((error) =>
            log.warn(`${label} could not close the Slack stream after its terminal write: ${String(error)}`),
          );
        });
      });
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        if (textTimer) textTimer.interruptUnsafe();
        if (!finalized) {
          pendingText += `${fullAnswer.trim() ? "\n\n" : ""}${GENERIC_FAILURE}`;
          yield* settleNative(fullAnswer.trim() || GENERIC_FAILURE).pipe(
            Effect.catchTag("PromiseFailure", (error) =>
              Effect.sync(() => log.error(`${label} failed to stop an abnormal Slack stream: ${String(error.cause)}`)),
            ),
          );
        }
      }),
    );
    yield* joinPromise(() => setStatus("processing", threadTitle));

    let messageId: string | undefined;
    let streamError: string | undefined;
    const textOf = answerText();
    /** An ending that is a failure: its notice woven into the stream, then the turn fails with it. */
    const failWith = (failure: SlackFailure) =>
      Effect.gen(function* () {
        finalized = true;
        yield* Effect.gen(function* () {
          const notice = yield* Effect.try({
            try: () => formatError(failure) ?? "",
            catch: (cause) => new PromiseFailure(cause),
          });
          if (notice) {
            pendingText += `${fullAnswer.trim() ? "\n\n" : ""}${notice}`;
            fullAnswer += `${fullAnswer.trim() ? "\n\n" : ""}${notice}`;
          }
          yield* settleNative(fullAnswer.trim() || GENERIC_FAILURE);
        }).pipe(
          Effect.catchTag("PromiseFailure", (error) =>
            Effect.sync(() => log.error(`${label} failed to deliver the agent-failure stream: ${String(error.cause)}`)),
          ),
        );
        return yield* Effect.fail(
          new PromiseFailure(new Error(`agent failed: ${failure.details} (retryable=${failure.retryable})`)),
        );
      });
    const appendAnswer = (text: string): void => {
      if (!text) return;
      pendingText += text;
      fullAnswer += text;
      scheduleText();
    };
    yield* Stream.runForEachWhile(events, (event) =>
      Effect.gen(function* () {
        if (event.type === "message") messageId = event.message.id;
        if (event.type === "stream_error") streamError = event.error.message;
        const end = turnEnd(event, messageId);
        if (end === undefined) {
          // Slack's native loading status represents private reasoning (`thinking` deltas) without exposing it.
          if (event.type === "delta" && event.channel === "text") appendAnswer(textOf(event));
          else if (event.type === "tool_started") {
            const trace = nativeToolTrace(event.name, event.args);
            toolTraces.set(event.toolCallId, trace);
            sendToolTrace(nativeToolLine(trace));
          } else if (event.type === "entry") {
            if (event.entry.kind === "assistant") appendAnswer(textOf(event));
            if (event.entry.kind === "tool_result") {
              const data = event.entry.data as { toolCallId?: string; isError?: boolean };
              const trace = (data.toolCallId && toolTraces.get(data.toolCallId)) || { label: "Tool" };
              if (data.toolCallId) toolTraces.delete(data.toolCallId);
              if (data.isError === true) sendToolTrace(nativeToolLine(trace, " failed"));
            }
          }
          return true;
        }
        if ("answered" in end) {
          finalized = true;
          const finalAnswer = withDisclaimer(fullAnswer, disclaimer);
          const footer = finalAnswer.slice(fullAnswer.trim().length);
          if (footer) pendingText += footer;
          // Before the terminal write, as in `renderReply`: what the stream has already appended is not delivery —
          // a stream left open by a dead process shows an unfinished answer.
          yield* Effect.try({ try: () => onAnswered?.(finalAnswer), catch: (cause) => new PromiseFailure(cause) });
          yield* settleNative(finalAnswer);
          return false;
        }
        return yield* failWith(end.failure);
      }).pipe(Effect.uninterruptible),
    );
    if (finalized) return;
    const unfinished = unfinishedTurn(streamError);
    if (unfinished === undefined) {
      return yield* Effect.fail(new PromiseFailure(new Error("stream ended without a terminal event")));
    }
    yield* failWith(unfinished).pipe(Effect.uninterruptible);
  });
}

export function slackReply(
  events: Stream.Stream<TurnEvent, PromiseFailure>,
  api: SlackApi,
  target: SlackTarget,
  formatError: (failure: SlackFailure) => string | undefined,
  options: {
    threadTitle?: string;
    disclaimer?: string | false;
    label?: string;
    onAnswered?: (answer: string) => void;
  } = {},
) {
  return Effect.suspend(() => {
    const { threadTitle, disclaimer, label = "[slack]", onAnswered } = options;
    return target.threadTs
      ? streamNativeSlackReply(events, api, target, formatError, threadTitle, disclaimer, label, onAnswered)
      : postSlackReply(events, api, target, formatError, disclaimer, label, onAnswered);
  });
}
