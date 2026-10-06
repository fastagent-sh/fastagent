/** The turn mechanism's ENGINE-agnostic half: the parts that describe a turn rather than pi. */
import { stripVTControlCharacters } from "node:util";
import {
  type AssistantMessage,
  type ImageContent,
  type ThinkingContent,
  type ToolResultMessage,
  contentText,
} from "@earendil-works/pi-ai";
import { ABORTED_CODE, type AgentEvent, type Json, type Prompt } from "../../agent.ts";
import type { AnswerOutcome, PromptDisposition, SessionEvent } from "../../session.ts";
import { log } from "../../log.ts";
import { beginWork } from "../../channels/busy.ts";

// ── Lease: single-writer concurrency floor ──────────────────────────────────
//
// Corruption-prevention floor only: it does not pick a UX.

export type Release = () => void;

export interface Lease {
  /** Try to acquire exclusive write access for the session (fail-fast). */
  tryAcquire(session: string): Release | null;
}

export function inProcessLease(): Lease {
  const busy = new Set<string>();
  return {
    tryAcquire(session: string): Release | null {
      if (busy.has(session)) return null;
      busy.add(session);
      // A session held is a turn or a compaction running, whatever started it (a channel, `/invoke`, a routine), so
      // it counts as the process's work in flight: what a restart waits for (dev-supervisor.ts).
      const workDone = beginWork();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        busy.delete(session);
        workDone();
      };
    },
  };
}
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
export function classifyRetryable(details: string, signal: { status?: number; code?: unknown }): boolean {
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
 * How an answer ended, read off the stopReason pi records on the message. The ONE reading: `message_finished`,
 * the `assistant` entry `entries()` publishes, and the invoke terminal all derive from it, so the live outcome and
 * the recorded one cannot disagree.
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
 * `assistant` entry's `thinking` ({@link answerThinking}) both apply it, so a client reads the same text either way.
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
 * hook that blocks it; pi 0.99.2's `tool_result` hook cannot set it). After a batch whose EVERY result asks it, pi
 * makes no further model call for that batch, so unless a queued steer or follow-up continues the run, it completes on
 * `tool` entries with no answer after them: the same shape a process killed after its tools leaves. A call made from
 * inside another tool (`parentToolCallId`, a codemode script) is not in the batch and does not count.
 * The ONE reading: the live `tool_finished` and the flag {@link markEndsRun} records both come from it.
 */
export function asksToEndRun(event: { result?: unknown; parentToolCallId?: string }): boolean {
  return !event.parentToolCallId && (event.result as { terminate?: unknown } | undefined)?.terminate === true;
}

/**
 * The tool result message as pi then records it, carrying the request: pi's `createToolResultMessage` drops
 * `terminate` (as of pi 0.99.2), so without this nothing in the record says the run ended on purpose.
 */
export function markEndsRun(message: ToolResultMessage): ToolResultMessage {
  return { ...message, terminate: true } as ToolResultMessage;
}

/** Whether a recorded tool result carries {@link markEndsRun}'s flag. */
export function endsRun(message: ToolResultMessage): boolean {
  return (message as { terminate?: unknown }).terminate === true;
}

/**
 * Terminal mapping, decided by the resolved message's outcome: pi's `prompt()` RESOLVES a message with stopReason
 * "error"/"aborted" rather than throwing, so relying on catch alone would miss that whole failure class and violate
 * SPEC MUST 1. A truncated final answer still completes the run.
 */
export function toTerminal(message: AssistantMessage): AgentEvent {
  const outcome = answerOutcome(message);
  if (outcome?.status === "aborted") {
    // A deliberate stop (a control-plane or consumer abort), not an error — see {@link ABORTED_CODE} for the consumer
    // contract (design §6).
    const details = outcome.error?.message ?? "run aborted";
    return { type: "failed", details, retryable: false, code: ABORTED_CODE };
  }
  if (outcome?.status === "failed") {
    const details = outcome.error?.message ?? "model stopped: error";
    return { type: "failed", details, retryable: classifyRetryable(details, messageSignal(message)) };
  }
  return { type: "completed" };
}

export function errorToTerminal(error: unknown): Extract<AgentEvent, { type: "failed" }> {
  const details = error instanceof Error ? error.message : String(error);
  return { type: "failed", details, retryable: classifyRetryable(details, errorSignal(error)) };
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
/** Live modulation handles for one active run — what the control plane's `dispatch` routes to. */
export interface RunControls {
  steer(prompt: Prompt): Promise<PromptDisposition>;
  followUp(prompt: Prompt): Promise<PromptDisposition>;
  abort(): Promise<void>;
}

/** The DATA-plane observation seam: every rich event of every run, pushed as it happens. */
export type SessionObserver = (session: string, event: SessionEvent, run?: RunControls) => void;

/**
 * The SPEC projection of ONE run's rich stream. Stateful only for `tool_progress`, the one event that is a status
 * rather than a fact: an outer call's status line is sent when it changes, and a call that call makes, at any depth,
 * is its status. Nested calls are otherwise the observation plane's alone.
 */
export function agentEventProjection(): (se: SessionEvent) => AgentEvent | null {
  /** Each nested call's outer call, the one the stream announced with `tool_started`. */
  const outerOf = new Map<string, string>();
  /** The status line each outer call last reported. */
  const shown = new Map<string, string>();
  const progress = (id: string, text: string | undefined): AgentEvent | null => {
    if (text === undefined || shown.get(id) === text) return null;
    shown.set(id, text);
    return { type: "tool_progress", id, text };
  };
  return (se) => {
    switch (se.type) {
      case "message_delta": {
        const d = se.data as { channel: "text" | "thinking"; delta: string };
        return d.channel === "text" ? { type: "text", delta: d.delta } : { type: "thinking", delta: d.delta };
      }
      case "tool_started": {
        const d = se.data as { id: string; name: string; args: Json; parentToolCallId?: string };
        if (!d.parentToolCallId) return { type: "tool_started", id: d.id, name: d.name, args: d.args };
        const outer = outerOf.get(d.parentToolCallId) ?? d.parentToolCallId;
        outerOf.set(d.id, outer);
        return progress(outer, callLine(d.name, d.args));
      }
      case "tool_progress": {
        const d = se.data as { id: string; partialResult: { content?: unknown }; parentToolCallId?: string };
        // A nested call's own output is not its caller's status; the nested call starting is (above).
        if (d.parentToolCallId || !Array.isArray(d.partialResult.content)) return null;
        return progress(d.id, lastLine(contentText(d.partialResult.content, "\n")));
      }
      case "tool_finished": {
        const d = se.data as { id: string; isError: boolean; content: Json; parentToolCallId?: string };
        if (d.parentToolCallId) return null;
        return { type: "tool_ended", id: d.id, isError: d.isError, content: d.content };
      }
      case "retry_scheduled": {
        // `operation` (compaction | branch_summary) stays session-plane vocabulary.
        const d = se.data as { attempt: number; maxAttempts: number; delayMs: number; error: string };
        return {
          type: "retrying",
          attempt: d.attempt,
          maxAttempts: d.maxAttempts,
          delayMs: d.delayMs,
          reason: d.error,
        };
      }
      default:
        return null;
    }
  };
}

/**
 * The line a terminal shows last: control sequences removed, and a bare `\r`, a progress bar redrawing in place, ends a
 * line like `\n` does. Undefined when there is no visible text yet (a shell that has printed nothing).
 */
function lastLine(text: string): string | undefined {
  const lines = stripVTControlCharacters(text).split(/\r\n|\r|\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (line) return line;
  }
  return undefined;
}

/** A nested call as its caller's status: the tool and its first plain argument, on one line (`weather London`). */
function callLine(name: string, args: Json): string {
  const first =
    args !== null && typeof args === "object" && !Array.isArray(args)
      ? Object.values(args).find((value) => typeof value === "string" || typeof value === "number")
      : undefined;
  return first === undefined ? name : `${name} ${String(first).replace(/\s+/g, " ").trim()}`.trim();
}
