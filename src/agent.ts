/**
 * Agent Handler protocol v0.1 — the engine-neutral contract (docs/SPEC.md). Pure types: importing an engine here is
 * forbidden (`@earendil-works/pi-*` may only appear under engines/).
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

export interface Scope {
  /** Opaque session anchor: turns of the same logical conversation MUST reuse the same value. */
  session: string;
  /**
   * EXTENSION (SPEC §8): the session this one branched from — a channel sets it when the place it is invoking for was
   * born out of another place (a thread opened in a room).
   */
  parentSession?: string;
  /**
   * EXTENSION (SPEC §8): opaque markers that MAY locate the branch point inside `parentSession` — e.g. platform
   * message ids its transcript embeds.
   */
  branchHints?: string[];
}

export type AgentEvent =
  | { type: "text"; delta: string }
  /** Model reasoning, streamed live. */
  | { type: "thinking"; delta: string }
  | { type: "tool_started"; id: string; name: string; args: Json }
  | { type: "tool_ended"; id: string; isError: boolean; content: Json }
  /**
   * Advisory, non-terminal (engines MAY emit it): a transient internal failure scheduled a retry with backoff — the
   * turn is still alive.
   */
  | { type: "retrying"; attempt: number; maxAttempts: number; delayMs: number; reason: string }
  /** Terminal: success. */
  | { type: "completed"; data?: Json }
  /** Terminal: failure. */
  | { type: "failed"; details: string; retryable: boolean; code?: string };

/**
 * The `failed.code` (SPEC §8 failure subdivision) the reference engine sets when a turn is rejected because the
 * session is BUSY.
 */
export const SESSION_BUSY_CODE = "session_busy";

/**
 * The `failed.code` set when a run was DELIBERATELY stopped. A channel MAY render cancellation distinctly from an
 * error, and MUST treat it as a settled outcome — durable turn-intent cleanup included — so a deliberate stop is
 * never replayed as a fresh turn on restart.
 */
export const ABORTED_CODE = "aborted";

/**
 * One turn = one invoke, returning a single async event stream. The stream MUST terminate with exactly one of
 * `completed` / `failed`, or be cancelled by the caller (no terminal event).
 */
export interface Agent {
  invoke(scope: Scope, prompt: Prompt): AsyncIterable<AgentEvent>;
}
