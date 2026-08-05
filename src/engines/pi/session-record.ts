/**
 * The `session` engine class's half of the SHARED durable record: bind a pi-coding-agent
 * `SessionManager` to the jsonl the session store owns, addressing it by the same opaque session id
 * the harness class uses.
 *
 * This exists as source rather than as advice because the binding is load-bearing and its failure is
 * silent. A `SessionManager` left to open its own file BUFFERS everything until the first assistant
 * message — so a crash between "the user asked" and "the model answered" loses the question, and the
 * file is never even created. Bound to a record that already exists, the user's turn persists
 * immediately, which is what the harness class has always done and what a channel's at-least-once
 * delivery assumes it can reconcile against.
 *
 * A rule with one implementation, not one description: `session-invoke.ts`'s factory contract states
 * it, and every caller gets it by calling this.
 */
import { JsonlSessionRepo, type NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { encodeSessionId } from "./sessions.ts";

export interface SessionRecordBinderOptions {
  /** Where the jsonl records live — the same directory the harness class's store is pointed at. */
  sessionsRoot: string;
  /** The workspace the records are grouped by (pi partitions sessions per project dir). */
  cwd: string;
  env: NodeExecutionEnv;
}

/**
 * A binder for one deployment: `sessionId → SessionManager` over that id's record, CREATING the
 * record when the id is new (so the returned manager is always in append-immediately mode).
 */
export function sessionRecordBinder(
  options: SessionRecordBinderOptions,
): (sessionId: string) => Promise<SessionManager> {
  const { sessionsRoot, cwd, env } = options;
  const repo = new JsonlSessionRepo({ fs: env, sessionsRoot });
  const recordPath = async (sessionId: string): Promise<string> => {
    // The SAME encoding `jsonlSessionStore` applies: session ids are caller-owned and land in
    // filenames (`telegram:-100/42` carries a path separator). Encoding differently here would give
    // the two engine classes two records for one conversation — the record they are supposed to
    // share is addressed by this string.
    const id = encodeSessionId(sessionId);
    const existing = (await repo.list({ cwd })).find((meta) => meta.id === id);
    if (existing) return existing.path;
    const created = await repo.create({ id, cwd });
    return (await created.getMetadata()).path;
  };
  return async (sessionId) => {
    const manager = SessionManager.create(cwd, sessionsRoot);
    manager.setSessionFile(await recordPath(sessionId));
    return manager;
  };
}
