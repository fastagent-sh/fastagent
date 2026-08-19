/**
 * The turn mechanism's ENGINE-agnostic half: the parts that describe a turn rather than pi. Not
 * "engine-neutral" in this repo's sense — that term is reserved for code with no engine import at
 * all (src/agent.ts), and the terminals here read pi's message shape. What they do not touch is how
 * a turn is driven, which is why they survived the engine change unaltered.
 *
 *   Lease       — single-writer concurrency floor (injectable port + in-process default)
 *   Terminals   — a settled pi message or a thrown error → the SPEC terminal, `retryable` included
 *   EventQueue  — push→pull plumbing for engines that emit events beside their result
 *   Prompt prep — SPEC images → pi's ImageContent
 *   Projection  — the rich SessionEvent stream → the narrow SPEC one
 *   Observation — the seam a control-plane hub attaches to (RunControls + SessionObserver)
 *
 * What is NOT neutral — pi's event vocabulary and how a turn is driven — stays in invoke-session.ts,
 * the L0 that owns it.
 */
import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import { ABORTED_CODE, type AgentEvent, type Json, type Prompt } from "../../agent.ts";
import type { SessionEvent } from "../../session.ts";

// ── Lease: single-writer concurrency floor ──────────────────────────────────
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
    // A deliberate stop (a control-plane or consumer abort), not an error — see {@link ABORTED_CODE}
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
/** Live modulation handles for one active run — what the control plane's `dispatch` routes to.
 *  Built inside the turn (it owns the engine instance); registered with the observer at
 *  run_started, gone after run_settled. RACE WINDOW (all three commands, symmetric): the run may
 *  resolve between the settled-check and the engine call landing — an accepted `abort` can still
 *  settle `completed`, and an accepted `steer`/`followUp` can settle without the prompt ever being
 *  consumed. Acceptance is not outcome; the settlement is the truth. */
export interface RunControls {
  steer(prompt: Prompt): Promise<void>;
  followUp(prompt: Prompt): Promise<void>;
  abort(): Promise<void>;
}

/** The DATA-plane observation seam: every rich event of every run, pushed as it happens. `run`
 *  carries the live {@link RunControls}, attached to the `run_started` event only. A hub
 *  (session-control.ts) implements this to serve `events()`/`state()`/`dispatch`; absent = zero
 *  overhead. Scope: RUN events only — the hub's own boundary-mutation events (`state_changed`,
 *  `compaction_*`) originate in the hub and reach full-vocabulary taps via the hub's `tap` option,
 *  not this seam. TRUST BOUNDARY: this seam hands every wired observer the run's modulation handles — it is the trusted hub seam, not a public fan-out point. Do not wire
 *  untrusted taps here; give third parties the read-only `events()` stream instead. */
export type SessionObserver = (session: string, event: SessionEvent, run?: RunControls) => void;

/** The SPEC projection of the rich stream. Events with no `AgentEvent` counterpart (progress,
 *  message boundaries, run boundaries) project to null — the invoke terminal is produced from the
 *  resolved message ({@link toTerminal}), not from `run_settled`. */
export function projectAgentEvent(se: SessionEvent): AgentEvent | null {
  switch (se.type) {
    case "message_delta": {
      const d = se.data as { channel: "text" | "thinking"; delta: string };
      return d.channel === "text" ? { type: "text", delta: d.delta } : { type: "thinking", delta: d.delta };
    }
    case "tool_started": {
      const d = se.data as { id: string; name: string; args: Json };
      return { type: "tool_started", id: d.id, name: d.name, args: d.args };
    }
    case "tool_finished": {
      const d = se.data as { id: string; isError: boolean; content: Json };
      return { type: "tool_ended", id: d.id, isError: d.isError, content: d.content };
    }
    case "retry_scheduled": {
      // `operation` (compaction | branch_summary) stays session-plane vocabulary — a turn renderer
      // only needs "transient failure, retrying"; the engine detail lives in the control plane.
      const d = se.data as { attempt: number; maxAttempts: number; delayMs: number; error: string };
      return { type: "retrying", attempt: d.attempt, maxAttempts: d.maxAttempts, delayMs: d.delayMs, reason: d.error };
    }
    default:
      return null;
  }
}

// ── EventQueue: push→pull plumbing for a two-port engine ────────────────────
//
// Single-consumer async queue; single-threaded JS means no await interleaves between push and
// drain, so no locking. Engines that are natively async-iterable would not need it.

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
