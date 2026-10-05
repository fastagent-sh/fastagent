/** `fastagent chat [agent]`: open the SAME assembled agent in pi's interactive TUI. */
import { failStartup } from "../fail.ts";
import { enterAgentCommand } from "../shared.ts";

export async function runChat(dirArg: string, opts: { model?: string }): Promise<void> {
  // Chat authenticates through fastagent's credential store like every other command (the shared session builder
  // injects it — see engines/pi/session-builder.ts), so the first-run picker and its inline login apply here too.
  const { agentDir, modelSpec } = await enterAgentCommand(dirArg, opts);
  // Lazy-import: chat pulls pi's interactive TUI module graph; headless start/dev never need it.
  const { runPiChat } = await import("../../engines/pi/chat.ts");
  await runPiChat(agentDir, { model: modelSpec }).catch(failStartup);
}
