/**
 * The `session` engine class's half of the SHARED durable record: bind a pi-coding-agent
 * `SessionManager` to the jsonl the session store owns, addressed by the same opaque session id the
 * harness class uses.
 *
 * This exists as source rather than as advice because the binding is load-bearing and its failure is
 * silent. A `SessionManager` left to open its own file BUFFERS everything until the first assistant
 * message — so a crash between "the user asked" and "the model answered" loses the question, and the
 * file is never even created. Bound to a record that already exists, the user's turn persists
 * immediately, which is what the harness class has always done and what a channel's at-least-once
 * delivery assumes it can reconcile against.
 *
 * The record is located THROUGH the store, never by re-deriving its layout: the id encoding, the cwd
 * scoping and the crash repair (`reconcileInterruptedToolCalls`) are one sequence, and a second copy
 * of it would eventually address a different file — two records for one conversation, the exact
 * failure this module exists to prevent.
 */
import { SessionManager, type SessionStartEvent } from "@earendil-works/pi-coding-agent";
import type { PiRecordLocator } from "./sessions.ts";

/** What a factory spreads into `createAgentSession` — both halves of "bind an existing record". */
export interface BoundSessionRecord {
  sessionManager: SessionManager;
  /**
   * ALWAYS `resume`, and that is the honest description rather than a shortcut: at per-invoke
   * locality a session object exists for one turn, and every one of them picks a durable record back
   * up — including the first, which resumes an empty one. pi's default (`startup`) would instead tell
   * an extension that turn 500 of a conversation is its first, every turn.
   *
   * What it deliberately does NOT try to be is "once per conversation". Three record-shaped
   * heuristics for that were tried and each lost or duplicated the announcement at a different edge
   * (the file exists but the turn died; the user's message persisted before the model was reached; an
   * aborted turn leaves an error-stopped assistant message), because "has this been announced" is a
   * fact about announcements, not about content. An extension that needs once-per-conversation setup
   * can read the record it is given; whether this engine class should offer more than that is part of
   * wiring it (#321), not something to invent before its first consumer exists.
   *
   * It travels WITH the manager so a factory cannot take one rule and forget the other.
   */
  sessionStartEvent: SessionStartEvent;
}

/**
 * A binder for one deployment: `sessionId →` what `createAgentSession` needs to speak to that id's
 * record in `store`. ONE argument on purpose — the layout comes from the store rather than being
 * re-supplied beside it, so a manager cannot be constructed over a root the records do not live in
 * (branch and fork write through that root, and a mismatch would make a second record for one
 * conversation).
 */
export function sessionRecordBinder(store: PiRecordLocator): (sessionId: string) => Promise<BoundSessionRecord> {
  const { sessionsRoot, cwd } = store.recordLayout;
  return async (sessionId) => {
    const sessionManager = SessionManager.create(cwd, sessionsRoot);
    sessionManager.setSessionFile(await store.ensureRecordPath(sessionId));
    return { sessionManager, sessionStartEvent: { type: "session_start", reason: "resume" } };
  };
}
