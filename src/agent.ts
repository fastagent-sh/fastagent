/**
 * Agent Handler protocol v0.1 — the harness-neutral contract (docs/SPEC.md). Pure types: importing a harness here is
 * forbidden (`@earendil-works/pi-*` may only appear under harnesses/).
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
   * Advisory, non-terminal (harnesses MAY emit it): the running tool `id`'s current status, one line, replacing the
   * last. It may be a line of the tool's output so far (trust it like `tool_ended.content`), never the whole output;
   * untruncated, so a consumer that shows it clips it.
   */
  | { type: "tool_progress"; id: string; text: string }
  /**
   * Advisory, non-terminal (harnesses MAY emit it): a transient internal failure scheduled a retry with backoff — the
   * turn is still alive.
   */
  | { type: "retrying"; attempt: number; maxAttempts: number; delayMs: number; reason: string }
  /** Terminal: success. */
  | { type: "completed"; data?: Json }
  /** Terminal: failure. */
  | { type: "failed"; details: string; retryable: boolean; code?: string };

/**
 * The `failed.code` (SPEC §8 failure subdivision) the reference harness sets when a turn is rejected because the
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
 * The `failed.code` set when a turn has no model to run on: its session records none of its own, and the agent sets
 * no default. Not retryable as is: giving the session a model (session control's `update({ model })`) or the agent a
 * default is what changes the answer.
 */
export const MISSING_MODEL_CODE = "missing_model";

/**
 * One turn = one invoke, returning a single async event stream. The stream MUST terminate with exactly one of
 * `completed` / `failed`, or be cancelled by the caller (no terminal event).
 */
export interface Agent {
  invoke(scope: Scope, prompt: Prompt): AsyncIterable<AgentEvent>;
}
