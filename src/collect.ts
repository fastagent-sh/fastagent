/**
 * Caller-side stream helpers: `collect` (buffered consumption, SPEC §7) reduces an AgentEvent
 * stream to a final value, encoding the terminal discipline (failed → throw, missing terminal →
 * error) — streaming consumers for-await themselves. `abortFirstIterator` is the shared
 * cancellation protocol for generator-backed streams.
 */
import type { AgentEvent, Json } from "./agent.ts";

/**
 * The abort-first cancellation protocol, ONCE: an async generator suspended on a quiet await (a
 * tool mid-execution, a silent SSE read) parks inside that await, and `gen.return()`/`gen.throw()`
 * queue behind the pending `next()` FOREVER (async-generator semantics) — a consumer's cancel
 * would deadlock. The wrapper's `return()` first runs `cancel` (abort the underlying work, which
 * settles the suspension), then delegates to `gen.return`, swallowing its rejection (the
 * generator's own catch/finally already surfaced the outcome). `throw()` tears down identically
 * and rethrows the caller's error deterministically instead of poking a completed generator.
 */
export function abortFirstIterator<T>(gen: AsyncGenerator<T>, cancel: () => void): AsyncIterator<T> {
  return {
    next: () => gen.next(),
    async return(value?: unknown) {
      cancel();
      await gen.return(value as never).catch(() => {});
      return { done: true as const, value: undefined };
    },
    async throw(error?: unknown): Promise<IteratorResult<T>> {
      cancel();
      await gen.return(undefined as never).catch(() => {});
      throw error;
    },
  };
}

/** Exception form of a failed event (thrown by collect). Carries the failed event's fields verbatim, so
 *  a buffered consumer can branch on `code` (SPEC §8 failure subdivision) just like a streaming one. */
export class AgentFailure extends Error {
  readonly details: string;
  readonly retryable: boolean;
  /** Machine-readable failure subdivision (SPEC §8), when the engine set one. */
  readonly code?: string;
  constructor(details: string, retryable: boolean, code?: string) {
    super(details);
    this.name = "AgentFailure";
    this.details = details;
    this.retryable = retryable;
    this.code = code;
  }
}

export interface CollectResult {
  text: string;
  data?: Json;
}

export async function collect(events: AsyncIterable<AgentEvent>): Promise<CollectResult> {
  let text = "";
  for await (const e of events) {
    if (e.type === "text") text += e.delta;
    else if (e.type === "completed") return { text, data: e.data };
    else if (e.type === "failed") throw new AgentFailure(e.details, e.retryable, e.code);
  }
  throw new Error("stream ended without a terminal event"); // violates SPEC MUST 1
}
