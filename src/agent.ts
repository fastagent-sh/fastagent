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
  /** Terminal: failure. `retryable` means it is worth re-sending with the same session. `code` is the
   *  optional machine-readable failure subdivision (SPEC §8) — a stable discriminator a consumer can branch
   *  on without parsing `details` (human-facing prose). */
  | { type: "failed"; details: string; retryable: boolean; code?: string };

/**
 * The `failed.code` (SPEC §8 failure subdivision) the reference engine sets when a turn is rejected because
 * the session is BUSY — another turn is already in flight, so THIS one never started and is replay-safe.
 * It lives in the contract (a code VALUE, not an engine import) so a neutral consumer — the scheduler,
 * which re-fires a busy wake-up but not one whose turn may have run side effects — branches on it without
 * text-matching `details` or reaching into the engine. An internal fastagent seam (engine ↔ scheduler),
 * not a public cross-engine mandate.
 */
export const SESSION_BUSY_CODE = "session_busy";

/**
 * The `failed.code` set when a run was deliberately stopped (a control-plane abort) rather than
 * failing on its own. Channels can render cancellation distinctly from an error, and MUST treat it
 * as a settled outcome — durable turn-intent cleanup included — so an operator's abort is never
 * replayed as a fresh turn on restart. Exported as a constant for the same reason as
 * {@link SESSION_BUSY_CODE}: a consumer that must branch on it should not string-match.
 */
export const ABORTED_CODE = "aborted";

/**
 * One turn = one invoke, returning a single async event stream. The stream MUST terminate with
 * exactly one of completed / failed, or be cancelled by the caller (no terminal event). Any
 * AsyncIterable producer that implements this conforms (interface, not base class).
 */
export interface Agent {
  invoke(scope: Scope, prompt: Prompt): AsyncIterable<AgentEvent>;
}
