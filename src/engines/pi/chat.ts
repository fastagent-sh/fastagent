/** Chat: open a workspace into pi's interactive TUI (`fastagent chat`). */
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { InteractiveMode, SessionManager } from "@earendil-works/pi-coding-agent";
import { canonicalPath } from "./definition.ts";
import { copyBranchInto } from "./session-inheritance.ts";
import { publishedLeaf } from "./session-markers.ts";
import { reconcileInterruptedToolCalls, sessionRecordPath } from "./session-store.ts";
import { type BuildSessionRuntimeOptions, buildAgentSessionRuntime } from "./session-builder.ts";

/**
 * Open a SERVED session (`schedule:digest`, a channel thread) as a private COPY.
 *
 * A copy rather than the record itself, because that record belongs to whoever is serving it: the running turn's
 * writer. Chat continuing it in place would append a second branch nothing reconciles, and a CLI that reads a
 * conversation must not be able to speak into it.
 *
 * The served FILE is never handed to pi either, only its bytes: `SessionManager.open` is a writing handle even
 * before anything is appended — its loader adds a newline when the last line has none (exactly what a process killed
 * mid-write leaves, which is the record most worth opening this way) and rewrites the whole file on a version
 * migration (exactly what the first run after a pi upgrade does). Both would land on a file a serve may be appending
 * to right now. So the bytes are copied to a scratch file first, and pi opens THAT.
 */
export async function openSessionCopy(
  workspace: string,
  sessionsDir: string,
  session: string,
): Promise<SessionManager> {
  const servedPath = sessionRecordPath({ dir: sessionsDir, cwd: workspace }, session);
  if (!servedPath) throw new Error(`no session "${session}" under ${sessionsDir} (\`fastagent info\` prints the dir)`);
  const scratchDir = mkdtempSync(join(tmpdir(), "fastagent-session-"));
  try {
    const scratch = join(scratchDir, basename(servedPath));
    copyFileSync(servedPath, scratch);
    const served = SessionManager.open(scratch, scratchDir);
    // The published head, not pi's last-line leaf: the store writes its own bookkeeping entries into the same journal.
    const leaf = publishedLeaf(served);
    if (!leaf) throw new Error(`session "${session}" has no turns yet — nothing to open`);
    // A NEW record in chat's own dir. CANONICAL cwd, like the builder's default SessionManager: pi derives that dir
    // by encoding the cwd, so a workspace reached through a symlink (`/tmp` on macOS) would otherwise put this copy
    // where a plain `chat`'s /resume never looks.
    const copy = SessionManager.create(canonicalPath(workspace), undefined, { parentSession: servedPath });
    // METADATA FIRST, history last: pi has one leaf pointer and every append advances it. The name travels for the
    // reason the store's `fork` states — a copy that lists as untitled is a row a user cannot place, and opening the
    // same served session twice would otherwise pile up indistinguishable records in `/resume`.
    copy.appendSessionInfo(served.getSessionName() ?? session);
    // The SAME branch copy inheritance uses, for the same reason it exists: it is the one that leaves the control
    // plane's own markers behind (`session-markers.ts`: never copied by a fork), which describe the served RECORD and
    // mean nothing in a private chat.
    copyBranchInto(served, copy, leaf);
    // The repair APPENDS a missing toolResult, so it runs on the COPY. The session most worth opening this way is the
    // one a fire was killed in the middle of — exactly the one carrying a dangling toolCall the provider would reject
    // on this chat's first message.
    return reconcileInterruptedToolCalls(copy);
  } finally {
    // The scratch file has served its purpose whether the copy succeeded or threw; leaving it would put a session's
    // content in /tmp for the rest of the boot.
    rmSync(scratchDir, { recursive: true, force: true });
  }
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
