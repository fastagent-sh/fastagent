/**
 * The turn mechanism — everything REQUEST-TIME lives in this module.
 * (Division of labor: create.ts decides WHAT parts an agent is assembled from,
 * configuration time; this module decides HOW a turn runs, request time.)
 *
 * pi reference implementation: fans pi AgentHarness's two ports (subscribe event
 * side-channel + prompt final value) into SPEC's single event stream. The module
 * is organized as the L0 entry plus the three mechanism parts it owns — they are
 * consumer-owned: each exists only because this orchestration needs it:
 *
 *   §1 Lease       — single-writer concurrency floor (injectable port + in-process default)
 *   §2 translate   — the single pi↔SPEC translation point (both directions)
 *   §3 EventQueue  — push→pull plumbing for pi's two-port shape
 *   §4 createPiAgentFromHarness — the L0 rung: composes §1–§3 into Agent.invoke
 *
 * createPiAgentFromHarness returns an object that **implements the Agent contract**
 * (composition, not inheritance).
 *
 * Concurrency: at most one in-flight turn per session. Contention = fail-fast: the
 * second invoke immediately yields `failed{retryable}` ("session busy"), leaving
 * dedupe/queueing/steering UX decisions to the channel.
 * Each invoke spins up a fresh harness bound to the session, discarded after use
 * (stateless multi-session). Session construction and env/model/tools injection all
 * live in the caller-provided harness factory.
 *
 * KNOWN DEBT: the orchestration skeleton here (lease + queue + single-stream terminal
 * discipline) is engine-generic, but the module is pi-coupled via PiHarnessFactory's
 * two-port shape (subscribe + prompt). When engine #2 lands, lift the skeleton out of
 * engines/pi instead of copying it — do not generalize before then.
 */
import type { AgentHarnessEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import type { Agent, AgentEvent, Json, Prompt, Scope } from "../../agent.ts";
import type { PiHarnessFactory } from "./harness.ts";

// ── §1 Lease: single-writer concurrency floor ───────────────────────────────
//
// **Contention policy = fail-fast, no queueing**: when already held, `tryAcquire`
// returns null and the caller emits `failed{retryable:true}` ("session busy").
// This is a corruption-prevention floor only — it does not pick a UX for any
// scenario: dedupe / queueing / steering are channel/upper-layer decisions
// (they know the trigger semantics).
//
// Why not queue: real same-session concurrency is mostly "duplicate intent"
// (dedupe) or "single user firing follow-ups" (steering), not "two real turns";
// FIFO serialization fits only the multi-participant case, and introduces an
// unbounded queue plus a slot-leak deadlock when a queued waiter is cancelled.
//
// Synchronous, no awaits: nothing interleaves between acquire and entering try,
// so cancellation at any point still releases in finally — no deadlock class.
// Cross-process/multi-instance distributed locking (TTL + fencing) is a separate
// future interface, not this one.

export type Release = () => void;

export interface Lease {
  /** Try to acquire exclusive write access for the session (fail-fast). Returns null if held. */
  tryAcquire(session: string): Release | null;
}

/** In-process single-writer: a per-session occupancy set. */
export function inProcessLease(): Lease {
  const busy = new Set<string>();
  return {
    tryAcquire(session: string): Release | null {
      if (busy.has(session)) return null;
      busy.add(session);
      let released = false;
      return () => {
        if (released) return; // idempotent
        released = true;
        busy.delete(session);
      };
    },
  };
}

// ── §2 translate: the single pi↔SPEC translation point (both directions) ────
//
//   pi → SPEC:
//   - toAgentEvent: in-stream events (text / tool_*); all other pi events return null (dropped).
//   - toTerminal:   the AssistantMessage resolved by pi `prompt()` → completed / failed.
//   - errorToTerminal: catch-all for genuine throws → failed.
//   SPEC → pi:
//   - toPiPromptOptions: SPEC Prompt images → pi prompt options.

/**
 * Classifies a failure's `details` as worth re-sending with the same session.
 * The SPEC `retryable` field is contract semantics; making the classifier an
 * injectable strategy keeps the contract from being hard-wired to one heuristic.
 */
export type RetryClassifier = (details: string) => boolean;

/**
 * Default: minimal string heuristic (pi's _isRetryableError is not exported —
 * KNOWN DEBT: replace with structured error classification if pi exports one).
 * Matching a transient-looking error pattern means "worth re-sending".
 */
const RETRYABLE =
  /\b(429|5\d\d|timeout|timed out|rate.?limit|overloaded|ECONNRESET|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|socket hang up)\b/i;

export const defaultRetryClassifier: RetryClassifier = (details) => RETRYABLE.test(details);

/** In-stream event mapping. Non text/tool_* pi events (turn_start, message_start, …) are dropped. */
function toAgentEvent(pe: AgentHarnessEvent): AgentEvent | null {
  switch (pe.type) {
    case "message_update":
      if (pe.assistantMessageEvent.type === "text_delta") {
        return { type: "text", delta: pe.assistantMessageEvent.delta };
      }
      return null;
    case "tool_execution_start":
      return {
        type: "tool_started",
        id: pe.toolCallId,
        name: pe.toolName,
        args: pe.args as Json,
      };
    case "tool_execution_end":
      return {
        type: "tool_ended",
        id: pe.toolCallId,
        isError: pe.isError,
        content: pe.result as Json,
      };
    default:
      return null;
  }
}

/**
 * Terminal mapping. **Decided by the resolved message's stopReason** (core-design §8):
 * pi's prompt() does not necessarily throw on model error/abort — the normal path is
 * resolving a message with stopReason "error" | "aborted". Relying on catch alone would
 * miss this entire failure class (violating MUST 1).
 */
function toTerminal(message: AssistantMessage, isRetryable: RetryClassifier): AgentEvent {
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    const details = message.errorMessage ?? `model stopped: ${message.stopReason}`;
    return { type: "failed", details, retryable: isRetryable(details) };
  }
  return { type: "completed" };
}

/** Catch-all: genuinely thrown exceptions → failed. */
function errorToTerminal(error: unknown, isRetryable: RetryClassifier): AgentEvent {
  const details = error instanceof Error ? error.message : String(error);
  return { type: "failed", details, retryable: isRetryable(details) };
}

/** SPEC Prompt → pi prompt options (the reverse direction: images attachment). */
function toPiPromptOptions(prompt: Prompt): { images?: ImageContent[] } | undefined {
  if (!prompt.images || prompt.images.length === 0) return undefined;
  return {
    images: prompt.images.map((img) => ({
      type: "image",
      data: img.data,
      mimeType: img.mimeType,
    })),
  };
}

// ── §3 EventQueue: push→pull plumbing for pi's two-port shape ────────────────
//
// Single-consumer async queue. It exists because of that shape: engines that are
// natively async-iterable (e.g. the claude SDK) would not need it.
// Single-threaded JS: no await interleaves between push and drain, so no locking.

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
   * Yield pushed events in order until `done` settles AND the buffer is drained.
   * Does not yield the result of `done` — the terminal is produced separately by the
   * caller (toTerminal). Rejections of `done` are swallowed here (the caller awaits
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

// ── §4 L0: createPiAgentFromHarness ─────────────────────────────────────────
//
// Defined HERE, not in create.ts, although it belongs to the create… ladder by name:
// its body is the turn mechanism itself (§1–§3 composed into an async generator).
// Moving the name to create.ts would either drag request-time code into the
// configuration-time file, or leave a one-line wrapper whose substance lives
// elsewhere. Name carries the API-family identity; location carries the
// lifecycle identity (see ladder rule 1 in create.ts).

export interface CreatePiAgentFromHarnessOptions {
  harnessFactory: PiHarnessFactory;
  /** Single-writer lease. Defaults to the in-process per-session fail-fast lease. */
  lease?: Lease;
  /** Strategy for the `failed.retryable` field. Defaults to defaultRetryClassifier (string heuristic). */
  retryClassifier?: RetryClassifier;
}

/** L0 of the assembly ladder: "from a harness factory" — engine wired by the caller, adds only the concurrency/stream shell. */
export function createPiAgentFromHarness(options: CreatePiAgentFromHarnessOptions): Agent {
  const { harnessFactory, lease = inProcessLease(), retryClassifier = defaultRetryClassifier } = options;

  async function* invoke(scope: Scope, prompt: Prompt): AsyncIterable<AgentEvent> {
    // Fail-fast single writer: if the session already has an in-flight turn, report
    // busy immediately — no queueing. tryAcquire is synchronous, so no await sits
    // between acquiring and entering try: cancellation anywhere still releases.
    const release = lease.tryAcquire(scope.session);
    if (!release) {
      yield {
        type: "failed",
        details: "session busy: a turn is already in flight for this session",
        retryable: true,
      };
      return;
    }
    try {
      let harness;
      try {
        harness = await harnessFactory(scope.session);
      } catch (error) {
        // Setup failures (session open / auth / …) MUST also surface as a failed
        // event, never as a throw.
        yield errorToTerminal(error, retryClassifier);
        return;
      }

      const queue = new EventQueue<AgentEvent>();
      const unsub = harness.subscribe((pe) => {
        const event = toAgentEvent(pe);
        if (event) queue.push(event);
      });
      try {
        const run = harness.prompt(prompt.text, toPiPromptOptions(prompt));
        // Yield text / tool_* as they happen, until run settles and the buffer drains.
        yield* queue.drainUntil(run);
        // Terminal is decided by the resolved message's stopReason; catch only
        // covers genuine throws.
        let terminal: AgentEvent;
        try {
          terminal = toTerminal(await run, retryClassifier);
        } catch (error) {
          terminal = errorToTerminal(error, retryClassifier);
        }
        yield terminal;
      } finally {
        // Both cancel (generator return → finally) and normal completion pass here.
        // Cleanup MUST NOT throw: an abort()/unsub() exception after the terminal
        // was yielded would make iteration throw, polluting an already-closed
        // event stream (violating SPEC MUST 2 / MUST 3).
        try {
          unsub();
        } catch {
          // ignore
        }
        try {
          await harness.abort();
        } catch {
          // ignore
        }
      }
    } finally {
      release(); // release after cleanup so the next invoke for this session can enter
    }
  }

  return { invoke };
}
