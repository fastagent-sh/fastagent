/** `fastagent chat [dir]`: open the SAME assembled agent in pi's interactive TUI. */
import { failStartup } from "../fail.ts";
import { enterAgentCommand } from "../shared.ts";

export async function runChat(dirArg: string, opts: { model?: string; authPath?: string }): Promise<void> {
  // Chat authenticates through fastagent's credential store like every other command (the shared
  // session builder injects it — see engines/pi/session-builder.ts), so the first-run picker and its
  // inline login apply here too.
  const placement = await enterAgentCommand(dirArg, opts);
  // Run the chat process AT the workspace: pi resolves a session's cwd as `header.cwd ?? process.cwd()`,
  // so aligning process.cwd() with the workspace keeps a cwd-less session on it. Paths are absolute.
  process.chdir(placement.workspace);
  // Lazy-import: chat pulls pi's interactive TUI module graph; headless start/dev never need it.
  const { runPiChat } = await import("../../engines/pi/chat.ts");
  await runPiChat(placement.workspace, { model: opts.model, authPath: opts.authPath }).catch(failStartup);
}
