/**
 * Turn plumbing shared by pi's TWO engine classes — the harness L0 (`invoke.ts`) and the session L0
 * (`session-invoke.ts`). It lives here rather than in either of them because neither engine class
 * may depend on the other: they are siblings behind one Agent contract, and a sibling import would
 * make the choice of engine class also a choice of which module graph loads.
 *
 * Four pieces, all engine-class-neutral: the single-writer lease, the pi→SPEC terminal
 * classification, the prompt→pi image conversion, and the push→pull fan-in both classes need
 * because pi exposes a turn as a promise PLUS a subscription.
 */
import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import { ABORTED_CODE, type AgentEvent, type Prompt } from "../../agent.ts";

// ── §1 Lease: single-writer concurrency floor ────────────────────────────────
//
// Corruption-prevention floor only: it does not pick a UX. Fail-fast over queueing because real
// same-session concurrency is mostly duplicate intent or a user firing follow-ups, not two real
// turns; a queue would also leak a slot when a waiter is cancelled. Synchronous (no awaits) so
// nothing interleaves between acquire and entering try — cancellation always releases in finally.

export type Release = () => void;

export interface Lease {
  /** Try to acquire exclusive write access for the session (fail-fast). Returns null if held. */
  tryAcquire(session: string): Release | null;
}

export function inProcessLease(): Lease {
  const busy = new Set<string>();
  return {
    tryAcquire(session: string): Release | null {
      if (busy.has(session)) return null;
      busy.add(session);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        busy.delete(session);
      };
    },
  };
}

// ── §2 Terminal classification: the pi→SPEC decision ─────────────────────────
//
// `retryable` = worth re-sending with the same session (SPEC §6: advisory, not a session-atomicity
// guarantee). Classify from the STRUCTURED signal first, prose only as the last-resort ceiling. What
// is actually available differs by path, and the two are NOT symmetric:
//   - thrown error (errorToTerminal): an HTTP `.status`/`.statusCode` AND a network `.code` (incl.
//     `.cause.code`) — this is where a numeric status genuinely drives the decision.
//   - failed message (toTerminal): ONLY `diagnostics[].error.code`. pi's `DiagnosticErrorInfo` carries
//     a `code` (a network code, or a status delivered as a code), with no separate HTTP-status field —
//     so a message whose provider `code` is a string label (e.g. "rate_limit_exceeded") is not
//     decisive here and falls to prose.
// The prose fallback is bounded, not a cop-out: pi-ai already ran its own status-code-based client
// retries (harness.ts PROVIDER_MAX_RETRIES) before surfacing, so an error that reaches this point has
// already exhausted the cleanly-retryable cases. The regex is the narrow ceiling, not the classifier.
// Upstream ask: a first-class `retryable`/`kind` on pi's terminal error would retire the prose path
// entirely (mirrors the §11 "the deeper fix is upstream in pi" pattern).

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

/**
 * Pull the structured error `code` pi records on a failed message's diagnostics. `diagnostics`
 * accumulates across attempts (`appendAssistantMessageDiagnostic`), so the terminal cause is the LAST
 * code-bearing entry — `findLast`, not `find`: an earlier attempt's transient 503 must not classify a
 * terminal 400/auth failure as retryable. (Reverse scan rather than `findLast` — the tsconfig lib is
 * ES2022.)
 */
function messageSignal(message: AssistantMessage): { status?: number; code?: unknown } {
  const diagnostics = message.diagnostics ?? [];
  for (let i = diagnostics.length - 1; i >= 0; i--) {
    const code = diagnostics[i]?.error?.code;
    if (code !== undefined) return { code };
  }
  return {};
}

/**
 * Terminal mapping, decided by the resolved message's stopReason: pi's prompt() resolves a message
 * with stopReason "error"/"aborted" rather than throwing, so relying on catch alone would miss this
 * entire failure class (violating SPEC MUST 1).
 */
export function toTerminal(message: AssistantMessage): AgentEvent {
  if (message.stopReason === "aborted") {
    // A deliberate stop (control-plane abort / harness abort), not an error — see {@link ABORTED_CODE}
    // for the consumer contract (design §6).
    const details = message.errorMessage ?? "run aborted";
    return { type: "failed", details, retryable: false, code: ABORTED_CODE };
  }
  if (message.stopReason === "error") {
    const details = message.errorMessage ?? `model stopped: ${message.stopReason}`;
    return { type: "failed", details, retryable: classifyRetryable(details, messageSignal(message)) };
  }
  return { type: "completed" };
}

export function errorToTerminal(error: unknown): Extract<AgentEvent, { type: "failed" }> {
  const details = error instanceof Error ? error.message : String(error);
  return { type: "failed", details, retryable: classifyRetryable(details, errorSignal(error)) };
}

// ── §3 Prompt images: one conversion for both classes ────────────────────────

/**
 * Map prompt images to pi ImageContent, resizing each to model-friendly dimensions/size with pi's
 * Photon resizer (reused from pi-coding-agent, lazy-imported so the common no-image headless path never
 * loads the TUI module graph). A null resize (unresizable / Photon unavailable) keeps the original
 * bytes — the provider then applies its own limit.
 */
export async function toPiPromptOptions(prompt: Prompt): Promise<{ images?: ImageContent[] } | undefined> {
  if (!prompt.images || prompt.images.length === 0) return undefined;
  const { resizeImage } = await import("@earendil-works/pi-coding-agent");
  const images = await Promise.all(
    prompt.images.map(async (img): Promise<ImageContent> => {
      const resized = await resizeImage(Buffer.from(img.data, "base64"), img.mimeType, {
        maxWidth: 1568,
        maxHeight: 1568,
        maxBytes: 5 * 1024 * 1024,
      }).catch(() => null);
      return resized
        ? { type: "image", data: resized.data, mimeType: resized.mimeType }
        : { type: "image", data: img.data, mimeType: img.mimeType };
    }),
  );
  return { images };
}

// ── §4 EventQueue: push→pull plumbing for pi's two-port shape ────────────────
//
// Single-consumer async queue; single-threaded JS means no await interleaves between push and
// drain, so no locking. Engines that are natively async-iterable would not need it. Exported for
// the sibling L0 (`session-invoke.ts`): both engine classes have pi's two-port shape (a promise for
// the turn + a subscription for the stream), so the fan-in is the same plumbing.

export class EventQueue<T> {
  private buffer: T[] = [];
  private wake?: () => void;

  push(item: T): void {
    this.buffer.push(item);
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  /**
   * Yield pushed events in order until `done` settles AND the buffer is drained. The terminal is
   * produced separately (toTerminal); rejections of `done` are swallowed here (the caller awaits
   * `run` itself) to avoid unhandled rejections.
   */
  async *drainUntil(done: Promise<unknown>): AsyncGenerator<T> {
    let settled = false;
    const onSettle = () => {
      settled = true;
      const wake = this.wake;
      this.wake = undefined;
      wake?.();
    };
    const finished = done.then(onSettle, onSettle);

    while (true) {
      while (this.buffer.length > 0) {
        yield this.buffer.shift() as T;
      }
      if (settled) break;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
    await finished;
  }
}
