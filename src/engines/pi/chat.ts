/**
 * Chat: open a workspace into pi's interactive TUI (`fastagent chat`). A pi-specific COMMAND, not an
 * engine-neutral channel: it drives pi's full session API (InteractiveMode) for fidelity, so it lives
 * under engines/pi/ and is not re-exported.
 *
 * The TUI is ONE consumer of the shared definition-aware builder (session-builder.ts) — the same
 * assembly, model surface, and fastagent auth that serving uses. Log in with `fastagent login` (or
 * pi's TUI `/login`, which writes through the same credential store into the workspace auth file).
 */
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { type BuildSessionRuntimeOptions, buildWorkspaceSessionRuntime } from "./session-builder.ts";

/**
 * Open the workspace's agent in pi's interactive TUI and run until the user exits. The agent is
 * fastagent's assembled agent (same model/tools/skills/prompt/auth as dev/start serve); pi's TUI
 * handles login, rendering, and same-workspace sessions natively.
 */
export async function runPiChat(dir: string, options: BuildSessionRuntimeOptions = {}): Promise<void> {
  const runtime = await buildWorkspaceSessionRuntime(dir, options);
  await new InteractiveMode(runtime, {}).run();
}
