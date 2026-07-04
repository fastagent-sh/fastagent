/**
 * Agent Handler protocol v0.1 — the engine-neutral contract (docs/SPEC.md). Pure types, zero
 * dependencies. Importing any engine implementation here is forbidden (`@earendil-works/pi-*` may
 * only appear under engines/).
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Base64-encoded image reference. */
export interface ImageRef {
  mimeType: string;
  data: string;
}

export interface Prompt {
  text: string;
  images?: ImageRef[];
}

/** Invocation scope. Core keeps only the `session` anchor; other fields are extensions (SPEC §8). */
export interface Scope {
  /** Opaque session anchor: turns of the same logical conversation MUST reuse the same value. */
  session: string;
}

export type AgentEvent =
  | { type: "text"; delta: string }
  /** Model reasoning, streamed live. Process, NOT the answer: consumers MUST NOT fold it into the final text. */
  | { type: "thinking"; delta: string }
  | { type: "tool_started"; id: string; name: string; args: Json }
  | { type: "tool_ended"; id: string; isError: boolean; content: Json }
  /** Terminal: success. `data` is attached only when the engine produces a structured result. */
  | { type: "completed"; data?: Json }
  /** Terminal: failure. `retryable` means it is worth re-sending with the same session. */
  | { type: "failed"; details: string; retryable: boolean };

/**
 * One turn = one invoke, returning a single async event stream. The stream MUST terminate with
 * exactly one of completed / failed, or be cancelled by the caller (no terminal event). Any
 * AsyncIterable producer that implements this conforms (interface, not base class).
 */
export interface Agent {
  invoke(scope: Scope, prompt: Prompt): AsyncIterable<AgentEvent>;
}
