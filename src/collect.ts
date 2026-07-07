/**
 * Buffered consumption helper (caller-side, SPEC §7): reduce an AgentEvent stream to a final value,
 * encoding the terminal discipline (failed → throw, missing terminal → error). Streaming consumers
 * for-await themselves.
 */
import type { AgentEvent, Json } from "./agent.ts";

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
