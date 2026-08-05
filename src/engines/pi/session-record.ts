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
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { PiRecordLocator } from "./sessions.ts";

export interface SessionRecordBinderOptions {
  /** The store that OWNS the records — the same one the harness class serves from. */
  store: PiRecordLocator;
  /** Where its records live, and the workspace they are grouped by: `SessionManager` is constructed
   *  with both, then pointed at the file the store resolved. */
  sessionsRoot: string;
  cwd: string;
}

/** A binder for one deployment: `sessionId → SessionManager` over that id's record in `store`. */
export function sessionRecordBinder(
  options: SessionRecordBinderOptions,
): (sessionId: string) => Promise<SessionManager> {
  const { store, sessionsRoot, cwd } = options;
  return async (sessionId) => {
    const manager = SessionManager.create(cwd, sessionsRoot);
    manager.setSessionFile(await store.recordPath(sessionId));
    return manager;
  };
}
