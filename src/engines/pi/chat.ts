/** Chat: open an agent directory into pi's interactive TUI (`fastagent chat`). */
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { type BuildSessionRuntimeOptions, buildAgentSessionRuntime } from "./session-builder.ts";

/** Open the agent in pi's interactive TUI and run until the user exits. */
export async function runPiChat(dir: string, options: BuildSessionRuntimeOptions = {}): Promise<void> {
  const runtime = await buildAgentSessionRuntime(dir, options);
  // The process runs where the agent works, the cwd every session here has, so what pi's TUI resolves against the
  // process's directory agrees with the session's.
  process.chdir(runtime.cwd);
  await new InteractiveMode(runtime, {}).run();
}
