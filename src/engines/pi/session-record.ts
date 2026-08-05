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
   * ALWAYS a resume: the record exists before the session is built, and binding emits this event on
   * every turn. pi's default (`reason: "startup"`) would tell an extension that turn 500 of a
   * conversation is its first, so anything that greets, seeds or logs on startup would do it every
   * turn. It travels WITH the manager so a factory cannot take one rule and forget the other.
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
