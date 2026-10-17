/**
 * How fastagent reads pi's messages: an answer's outcome and published thinking, whether a tool result asked to end its
 * run, a prompt's images, and the run outcome an answer or a thrown error makes.
 */
import type { AssistantMessage, ImageContent, ThinkingContent, ToolResultMessage } from "@earendil-works/pi-ai";
import type { LoopOutcome } from "../../loop-port.ts";
import { type AgentError, type Prompt, agentError } from "../../protocol.ts";
import { log } from "../../log.ts";

/**
 * How an answer ended, when it did not end normally. `truncated` is an answer cut off at the output limit, a property
 * of the answer rather than its run.
 */
export type AnswerOutcome = { status: "failed" | "aborted" | "truncated"; error?: { message: string } };

/** Clearly-transient network error codes (Node/undici), decisive on their own. */
const RETRYABLE_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ENETUNREACH",
  "ENETDOWN",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/** 429 (rate limit) and 5xx (server) are worth retrying; other statuses are decisive NON-retryable. */
const statusIsRetryable = (status: number): boolean => status === 429 || (status >= 500 && status < 600);

/** Last-resort prose match, used only when no structured status/code is available. */
const RETRYABLE_MESSAGE =
  /\b(429|5\d\d|timeout|timed out|rate.?limit|overloaded|ECONNRESET|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|socket hang up)\b/i;

/** A structured status/code decision, or `null` when the signal is absent/undecisive → fall to prose. */
function retryableFromSignal(signal: { status?: number; code?: unknown }): boolean | null {
  if (typeof signal.status === "number") return statusIsRetryable(signal.status);
  const { code } = signal;
  if (typeof code === "number") return statusIsRetryable(code);
  if (typeof code === "string") {
    if (RETRYABLE_CODES.has(code)) return true;
    if (/^\d{3}$/.test(code)) return statusIsRetryable(Number(code)); // a status carried as a string
  }
  return null; // no code, or an unknown one — not decisive on its own
}

/** Classify `retryable`: structured status/code first, message prose only as the last-resort ceiling. */
function classifyRetryable(details: string, signal: { status?: number; code?: unknown }): boolean {
  return retryableFromSignal(signal) ?? RETRYABLE_MESSAGE.test(details);
}

/** Pull a structured status/code off a thrown error (HTTP status or a network code, incl. its cause). */
function errorSignal(error: unknown): { status?: number; code?: unknown } {
  if (!error || typeof error !== "object") return {};
  const e = error as { status?: unknown; statusCode?: unknown; code?: unknown; cause?: unknown };
  const status = typeof e.status === "number" ? e.status : typeof e.statusCode === "number" ? e.statusCode : undefined;
  const causeCode = e.cause && typeof e.cause === "object" ? (e.cause as { code?: unknown }).code : undefined;
  return { status, code: e.code ?? causeCode };
}

/** Pull the structured error `code` pi records on a failed message's diagnostics. */
function messageSignal(message: AssistantMessage): { status?: number; code?: unknown } {
  const diagnostics = message.diagnostics ?? [];
  for (let i = diagnostics.length - 1; i >= 0; i--) {
    const code = diagnostics[i]?.error?.code;
    if (code !== undefined) return { code };
  }
  return {};
}
/**
 * How an answer ended, read off the stopReason pi records on the message. The ONE reading: the `assistant_message`
 * entry and the run's outcome both derive from it, so the recorded answer and the run cannot disagree.
 */
export function answerOutcome(message: AssistantMessage): AnswerOutcome | undefined {
  const error = message.errorMessage ? { error: { message: message.errorMessage } } : {};
  switch (message.stopReason) {
    case "error":
      return { status: "failed", ...error };
    case "aborted":
      return { status: "aborted", ...error };
    case "length":
      return { status: "truncated" };
    default:
      return undefined;
  }
}

/**
 * An answer that failed while its run's abort was in effect, as what it was: aborted. Undefined when that is not the
 * case (no abort, or not a failure). pi's own reading is `signal.aborted ? "aborted" : "error"` (`handleRunFailure`,
 * the providers), but its request-setup path (`lazyStream`: auth, request preparation) writes "error" whatever the
 * signal (pi 0.99.2). A run stopped during a tool lands there: the loop asks the model once more, and the setup throws
 * the abort. Recorded this way, the answer's {@link answerOutcome} is the `aborted` the run settled with, live and read
 * back. A failure recorded BEFORE the abort (a provider error whose retry was then stopped) stays as recorded.
 */
export function abortedAnswer(
  message: AssistantMessage,
  runSignal: AbortSignal | undefined,
): AssistantMessage | undefined {
  return message.stopReason === "error" && runSignal?.aborted === true
    ? { ...message, stopReason: "aborted" }
    : undefined;
}

/**
 * Whether a thinking block is PUBLISHED: readable reasoning. A redacted one holds a provider's opaque payload and a
 * placeholder (pi writes "[Reasoning redacted]" for it), not reasoning anyone can read, so it is neither streamed nor
 * read back. The ONE rule: the live `message_delta { channel: "thinking" }` ({@link streamsThinkingDelta}) and the
 * `assistant_message` entry's `thinking` ({@link answerThinking}) both apply it, so a client reads the same text either
 * way.
 *
 * One exception, by when the flag is read: live reads it as each delta arrives, the record as the answer ended. pi's
 * Bedrock path flags a block redacted when its first encrypted chunk arrives, and its readable text and its encrypted
 * chunks are separate fields, so a block that streamed readable text BEFORE turning redacted had that text streamed
 * and is then not read back. Not separable after the fact: the record keeps one flag and one string per block, with
 * pi's placeholder appended. Whether a Bedrock model sends both in one block is unverified.
 */
function isPublishedThinking(block: AssistantMessage["content"][number] | undefined): block is ThinkingContent {
  return block?.type === "thinking" && block.redacted !== true;
}

/**
 * An answer's recorded thinking: its published thinking blocks, in order, joined with nothing between them, exactly as
 * their live deltas add up (the stream marks no block boundary, and the answer's `text` is joined the same way).
 * Undefined when it has none.
 */
export function answerThinking(message: AssistantMessage): string | undefined {
  const text = message.content
    .filter(isPublishedThinking)
    .map((block) => block.thinking)
    .join("");
  return text === "" ? undefined : text;
}

/** Whether a live thinking delta is streamed: the block it extends is one {@link answerThinking} will publish. */
export function streamsThinkingDelta(event: { contentIndex: number; partial: AssistantMessage }): boolean {
  return isPublishedThinking(event.partial.content[event.contentIndex]);
}

/**
 * Whether a finished tool call asked to end its run (pi's `terminate`: returned by the tool, or set by a `tool_call`
 * hook that blocks it; pi 1.3.0's `tool_result` hook cannot set it). After a batch whose EVERY result asks it, pi
 * makes no further model call for that batch, so unless a queued steer or follow-up continues the run, it completes on
 * `tool_result` entries with no answer after them: the same shape a process killed after its tools leaves. A call made
 * from inside another tool (`parentToolCallId`, a codemode script) is not in the batch and does not count. The flag
 * {@link markEndsRun} records comes from it.
 */
export function asksToEndRun(event: { result?: unknown; parentToolCallId?: string }): boolean {
  return !event.parentToolCallId && (event.result as { terminate?: unknown } | undefined)?.terminate === true;
}

/**
 * The tool result message as pi then records it, carrying the request: pi's `createToolResultMessage` drops
 * `terminate` (as of pi 1.3.0), so without this nothing in the record says the run ended on purpose.
 */
export function markEndsRun(message: ToolResultMessage): ToolResultMessage {
  return { ...message, terminate: true } as ToolResultMessage;
}

/** Whether a recorded tool result carries {@link markEndsRun}'s flag. */
export function endsRun(message: ToolResultMessage): boolean {
  return (message as { terminate?: unknown }).terminate === true;
}

/**
 * A run's failure from what pi threw: worth sending again when its status or network code says so (a model error),
 * otherwise an internal fault.
 */
export function thrownFailure(error: unknown): AgentError {
  const message = error instanceof Error ? error.message : String(error);
  return classifyRetryable(message, errorSignal(error))
    ? { ...agentError("model_error", message), retryable: true }
    : agentError("internal", message);
}

/**
 * How a run ended, by its last answer. pi's `prompt()` RESOLVES a message that failed or was aborted rather than
 * throwing, so the answer is read rather than relying on a catch. A truncated answer still answers: `max_tokens`. An
 * aborted one is a failure here; a run the caller stopped is reported `canceled` by the port, which knows it asked.
 */
export function answeredOutcome(message: AssistantMessage): LoopOutcome {
  const outcome = answerOutcome(message);
  if (outcome?.status === "truncated") return { status: "max_tokens" };
  if (outcome?.status === "aborted") {
    return { status: "failed", error: agentError("internal", outcome.error?.message ?? "run aborted") };
  }
  if (outcome?.status === "failed") {
    const details = outcome.error?.message ?? "model stopped: error";
    return {
      status: "failed",
      error: { ...agentError("model_error", details), retryable: classifyRetryable(details, messageSignal(message)) },
    };
  }
  return { status: "completed" };
}

/**
 * Map prompt images to pi ImageContent. `prompt()` normalizes its images itself, with the bound model's resize
 * profile (`inputLimits.images.resize`) and format conversion, so a `"prompt"` delivery hands them over as-is.
 * `steer`/`followUp` do not, so a `"queued"` delivery resizes here with pi's default profile: the model is not known
 * yet when a queued message is prepared. pi's resizer is lazy-imported so the no-image path never loads its module
 * graph.
 */
export async function toPiPromptOptions(
  prompt: Prompt,
  delivery: "prompt" | "queued",
): Promise<{ images?: ImageContent[] } | undefined> {
  if (!prompt.images || prompt.images.length === 0) return undefined;
  if (delivery === "prompt") {
    return { images: prompt.images.map((img) => ({ type: "image", data: img.data, mimeType: img.mimeType })) };
  }
  const { resizeImage } = await import("@earendil-works/pi-coding-agent");
  const images = await Promise.all(
    prompt.images.map(async (img, i): Promise<ImageContent> => {
      const resized = await resizeImage(Buffer.from(img.data, "base64"), img.mimeType);
      if (resized) return { type: "image", data: resized.data, mimeType: resized.mimeType };
      // `null` covers an image it cannot decode or shrink under the limit AND an image backend that did not load,
      // and does not say which. pi's own tool-result path keeps the original in that case rather than drop what the
      // sender attached, and so does this; a provider that refuses it fails the turn with its own message.
      log.warn(
        `[fastagent] queued image ${i + 1} (${img.mimeType}) could not be resized; sending it as given — ` +
          "the provider may refuse it",
      );
      return { type: "image", data: img.data, mimeType: img.mimeType };
    }),
  );
  return { images };
}
