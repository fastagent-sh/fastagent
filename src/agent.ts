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
  /** EXTENSION (SPEC §8): the session this one branched from — a channel sets it when the place it
   *  is invoking for was born out of another place (a thread opened in a room). Read ONLY when
   *  `session` does not exist yet: an engine that understands it seeds the NEW session from the
   *  parent once, at creation; after that the field is ignored, and an engine that does not
   *  understand it ignores it entirely (the session starts empty, yesterday's behavior). */
  parentSession?: string;
  /** EXTENSION (SPEC §8): opaque markers that MAY locate the branch point inside `parentSession` —
   *  e.g. platform message ids its transcript embeds. Best-effort by design: the first marker found
   *  in the parent's transcript wins, and no match falls back to the parent's present. Meaningless
   *  without `parentSession`. */
  branchHints?: string[];
}

export type AgentEvent =
  | { type: "text"; delta: string }
  /** Model reasoning, streamed live. Process, NOT the answer: consumers MUST NOT fold it into the final text. */
  | { type: "thinking"; delta: string }
  | { type: "tool_started"; id: string; name: string; args: Json }
  | { type: "tool_ended"; id: string; isError: boolean; content: Json }
  /** Advisory, non-terminal (engines MAY emit it): a transient internal failure scheduled a retry
   *  with backoff — the turn is still alive. Explains a quiet gap that would otherwise read as a
   *  hang; deliberately unclosed — the next event is its closure. Terminal consumers ignore it
   *  (SPEC MUST 4). */
  | { type: "retrying"; attempt: number; maxAttempts: number; delayMs: number; reason: string }
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
 * The `failed.code` set when a run was DELIBERATELY stopped — a control-plane abort, or any
 * engine-level abort it attributes (`stopReason: "aborted"`) — rather than failing on its
 * own. Channels can render cancellation distinctly from an error, and MUST treat it as a settled
 * outcome — durable turn-intent cleanup included — so a deliberate stop is never replayed as a
 * fresh turn on restart. Exported as a constant for the same reason as {@link SESSION_BUSY_CODE}:
 * a consumer that must branch on it should not string-match.
 */
export const ABORTED_CODE = "aborted";

/**
 * The `failed.code` set when a turn carried an attachment the agent has no way to open — a local
 * file with no `read` tool mounted. A CONFIGURATION limitation, not an unknown failure: the channel
 * knows exactly what is wrong and can say so, where the generic "something went wrong" would leave
 * the user guessing at a problem only the operator can fix. Exported for the same reason as
 * {@link SESSION_BUSY_CODE}: its consumer (`defaultErrorMessage`, and any channel's own `onError`)
 * must branch on it rather than string-match the message.
 */
export const ATTACHMENT_UNSUPPORTED_CODE = "attachment_unsupported";

/**
 * One turn = one invoke, returning a single async event stream. The stream MUST terminate with
 * exactly one of completed / failed, or be cancelled by the caller (no terminal event). Any
 * AsyncIterable producer that implements this conforms (interface, not base class).
 */
export interface Agent {
  invoke(scope: Scope, prompt: Prompt): AsyncIterable<AgentEvent>;
}
