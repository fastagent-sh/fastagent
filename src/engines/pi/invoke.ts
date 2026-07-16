/**
 * The turn mechanism (request-time): fan pi AgentHarness's two ports (subscribe event side-channel
 * + prompt final value) into SPEC's single event stream, under a single-writer-per-session lease.
 *
 *   §1 Lease       — single-writer concurrency floor (injectable port + in-process default)
 *   §2 translate   — the single pi↔SPEC translation point (both directions)
 *   §3 EventQueue  — push→pull plumbing for pi's two-port shape
 *   §4 createPiAgentFromHarness — composes §1–§3 into Agent.invoke
 *
 * Concurrency: at most one in-flight turn per session; a second invoke fails fast with
 * `failed{retryable}` ("session busy"), leaving dedupe/queueing/steering to the channel. Each
 * invoke builds a fresh harness bound to the session and discards it (stateless multi-session).
 */
import type { AgentHarnessEvent } from "@earendil-works/pi-agent-core";
import { DEFAULT_COMPACTION_SETTINGS, calculateContextTokens, shouldCompact } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import { type Agent, type AgentEvent, type Json, type Prompt, type Scope, SESSION_BUSY_CODE } from "../../agent.ts";
import { log } from "../../log.ts";
import type { PiHarnessFactory } from "./harness.ts";
import { type ToolActivation, additiveActivation, turnContext } from "./tool-context.ts";

// ── §1 Lease: single-writer concurrency floor ───────────────────────────────
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

// ── §2 translate: the single pi↔SPEC translation point ───────────────────────
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

/** In-stream event mapping. Non text/tool_* pi events (turn_start, message_start, …) are dropped. */
function toAgentEvent(pe: AgentHarnessEvent): AgentEvent | null {
  switch (pe.type) {
    case "message_update": {
      const ev = pe.assistantMessageEvent;
      if (ev.type === "text_delta") return { type: "text", delta: ev.delta };
      if (ev.type === "thinking_delta") return { type: "thinking", delta: ev.delta };
      return null;
    }
    case "tool_execution_start":
      return { type: "tool_started", id: pe.toolCallId, name: pe.toolName, args: pe.args as Json };
    case "tool_execution_end":
      return { type: "tool_ended", id: pe.toolCallId, isError: pe.isError, content: pe.result as Json };
    default:
      return null;
  }
}

/**
 * Terminal mapping, decided by the resolved message's stopReason: pi's prompt() resolves a message
 * with stopReason "error"/"aborted" rather than throwing, so relying on catch alone would miss this
 * entire failure class (violating SPEC MUST 1).
 */
export function toTerminal(message: AssistantMessage): AgentEvent {
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    const details = message.errorMessage ?? `model stopped: ${message.stopReason}`;
    return { type: "failed", details, retryable: classifyRetryable(details, messageSignal(message)) };
  }
  return { type: "completed" };
}

export function errorToTerminal(error: unknown): AgentEvent {
  const details = error instanceof Error ? error.message : String(error);
  return { type: "failed", details, retryable: classifyRetryable(details, errorSignal(error)) };
}

type PiHarness = Awaited<ReturnType<PiHarnessFactory>>;

/**
 * The turn's {@link ToolActivation} over the live harness. `activate` is additive and filters to the
 * registered names first — pi's `setActiveTools` THROWS on unknown names, and a loader must get a
 * usable "nothing new" answer, not an exception. pi persists the change in the session, so the
 * per-invoke restore (harness.ts) carries it into later turns.
 */
function toolActivation(harness: PiHarness): ToolActivation {
  return {
    active: () => harness.getActiveTools().map((t) => t.name),
    registered: () => harness.getTools().map((t) => ({ name: t.name, description: t.description ?? "" })),
    async activate(names) {
      const current = harness.getActiveTools().map((t) => t.name);
      const added = additiveActivation(
        harness.getTools().map((t) => t.name),
        current,
        names,
      );
      if (added.length > 0) await harness.setActiveTools([...current, ...added]);
      return added;
    },
  };
}

/**
 * After a successful turn, compact the session if its context has grown past pi's threshold — a long
 * shared (group) or 1:1 conversation otherwise overflows the model's window. pi owns the mechanism
 * (`harness.compact()` writes a summary entry into the session, so the next reopen is compacted); the
 * bare harness does NOT auto-trigger it, so fastagent checks `shouldCompact` here and fires it. The
 * context size is the provider's own count from the turn's assistant message (`usage`).
 */
async function maybeCompact(harness: PiHarness, message: AssistantMessage): Promise<void> {
  const contextWindow = harness.getModel().contextWindow;
  if (!contextWindow) return;
  if (shouldCompact(calculateContextTokens(message.usage), contextWindow, DEFAULT_COMPACTION_SETTINGS)) {
    await harness.compact();
  }
}

/**
 * Map prompt images to pi ImageContent, resizing each to model-friendly dimensions/size with pi's
 * Photon resizer (reused from pi-coding-agent, lazy-imported so the common no-image headless path never
 * loads the TUI module graph). A null resize (unresizable / Photon unavailable) keeps the original
 * bytes — the provider then applies its own limit.
 */
async function toPiPromptOptions(prompt: Prompt): Promise<{ images?: ImageContent[] } | undefined> {
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

// ── §3 EventQueue: push→pull plumbing for pi's two-port shape ────────────────
//
// Single-consumer async queue; single-threaded JS means no await interleaves between push and
// drain, so no locking. Engines that are natively async-iterable would not need it.

class EventQueue<T> {
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

// ── §4 createPiAgentFromHarness ──────────────────────────────────────────────

export interface CreatePiAgentFromHarnessOptions {
  harnessFactory: PiHarnessFactory;
  /** Single-writer lease. Defaults to the in-process per-session fail-fast lease. */
  lease?: Lease;
}

/** "From a harness factory": engine wired by the caller; adds only the concurrency/stream shell. */
export function createPiAgentFromHarness(options: CreatePiAgentFromHarnessOptions): Agent {
  const { harnessFactory, lease = inProcessLease() } = options;

  async function* invoke(scope: Scope, prompt: Prompt): AsyncIterable<AgentEvent> {
    const release = lease.tryAcquire(scope.session);
    if (!release) {
      yield {
        type: "failed",
        details: "session busy: a turn is already in flight for this session",
        retryable: true,
        code: SESSION_BUSY_CODE,
      };
      return;
    }
    try {
      let harness: Awaited<ReturnType<PiHarnessFactory>>;
      try {
        harness = await harnessFactory(scope.session);
      } catch (error) {
        // Setup failures (session open / auth / …) MUST surface as a failed event, never a throw.
        yield errorToTerminal(error);
        return;
      }

      const queue = new EventQueue<AgentEvent>();
      const unsub = harness.subscribe((pe) => {
        const event = toAgentEvent(pe);
        if (event) queue.push(event);
      });
      let completed: AssistantMessage | undefined; // the assistant message of a cleanly completed turn
      try {
        // Run the turn inside the session context so a tool's `execute` can read which session it is in
        // (turnContext / ToolContext.session). prompt() starts the async work synchronously here, so the
        // store propagates to the tool calls awaited within it.
        const opts = await toPiPromptOptions(prompt);
        const run = turnContext.run({ session: scope.session, tools: toolActivation(harness) }, () =>
          harness.prompt(prompt.text, opts),
        );
        yield* queue.drainUntil(run);
        let terminal: AgentEvent;
        try {
          const message = await run;
          terminal = toTerminal(message);
          if (terminal.type === "completed") completed = message;
        } catch (error) {
          terminal = errorToTerminal(error);
        }
        yield terminal;
      } finally {
        // After a successful turn, keep the session under the model's context window (a long shared group
        // or 1:1 conversation would otherwise overflow). Runs HERE — before teardown (it uses the harness)
        // and BEFORE the lease release below, and is awaited via the generator's return(), so the next
        // turn for this session waits and never reopens mid-compaction. That await rides the consumer's
        // iteration: a STREAMING consumer (e.g. telegram) already sent the reply on the terminal before
        // returning, so compaction — rare, only over threshold — does not delay it; a `collect`-style
        // consumer returns the reply FROM the loop, so it waits for the (occasional) compaction. Non-fatal:
        // a failed compaction leaves the (still-valid) session for the next turn to retry.
        if (completed) {
          try {
            await maybeCompact(harness, completed);
          } catch (error) {
            log.warn(`[fastagent] auto-compaction failed during cleanup: ${String(error)}`);
          }
        }
        // Cleanup MUST NOT throw after the terminal was yielded — that would make an already-closed
        // event stream throw on iteration (violating SPEC MUST 2 / MUST 3). Contain it, but surface it
        // (a cleanup failure is abnormal).
        try {
          unsub();
        } catch (error) {
          log.warn(`[fastagent] harness unsubscribe failed during cleanup: ${String(error)}`);
        }
        try {
          await harness.abort();
        } catch (error) {
          log.warn(`[fastagent] harness abort failed during cleanup: ${String(error)}`);
        }
      }
    } finally {
      release(); // after cleanup, so the next invoke for this session can enter
    }
  }

  return { invoke };
}
