/** Chat: open a workspace into pi's interactive TUI (`fastagent chat`). */
import { InteractiveMode, SessionManager } from "@earendil-works/pi-coding-agent";
import { publishedLeaf } from "./session-markers.ts";
import { piSessionRecordStore } from "./session-store.ts";
import { type BuildSessionRuntimeOptions, buildAgentSessionRuntime } from "./session-builder.ts";

/**
 * Open a SERVED session (`schedule:digest`, a channel thread) as a private COPY.
 *
 * A copy rather than the record itself, because that record belongs to whoever is serving it: the running turn's
 * writer. Chat continuing it in place would append a second branch nothing reconciles, and a CLI that reads a
 * conversation must not be able to speak into it. So chat reads the served record and writes only into its own
 * session dir; the served one is never opened for append.
 */
export async function openSessionCopy(
  workspace: string,
  sessionsDir: string,
  session: string,
): Promise<SessionManager> {
  const served = await piSessionRecordStore({ dir: sessionsDir, cwd: workspace }).openIfExists(session);
  if (!served) throw new Error(`no session "${session}" under ${sessionsDir} (\`fastagent info\` prints the dir)`);
  const file = served.getSessionFile();
  // The published head, not pi's last-line leaf: the store writes its own bookkeeping entries into the same journal.
  const leaf = publishedLeaf(served);
  if (!file || !leaf) throw new Error(`session "${session}" has no turns yet — nothing to open`);
  // The second argument is where /new and /branch write, so the copy lands in chat's own dir, not the served one.
  const copy = SessionManager.open(file, SessionManager.create(workspace).getSessionDir());
  copy.createBranchedSession(leaf);
  return copy;
}

/** Open the workspace's agent in pi's interactive TUI and run until the user exits. */
export async function runPiChat(
  dir: string,
  options: BuildSessionRuntimeOptions = {},
  open?: { session: string; sessionsDir: string },
): Promise<void> {
  const copy = open ? await openSessionCopy(dir, open.sessionsDir, open.session) : undefined;
  const runtime = await buildAgentSessionRuntime(dir, options, copy);
  await new InteractiveMode(runtime, {}).run();
}
