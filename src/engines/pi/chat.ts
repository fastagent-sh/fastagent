/** Chat: open an agent directory into pi's interactive TUI (`fastagent chat`). */
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { type BuildSessionRuntimeOptions, buildAgentSessionRuntime } from "./session-builder.ts";

/** Open the agent in pi's interactive TUI and run until the user exits. */
export async function runPiChat(dir: string, options: BuildSessionRuntimeOptions = {}): Promise<void> {
  const runtime = await buildAgentSessionRuntime(dir, options);
  await new InteractiveMode(runtime, {}).run();
}
