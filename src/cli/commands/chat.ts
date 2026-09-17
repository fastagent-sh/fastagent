/** `fastagent chat [dir]`: open the SAME assembled agent in pi's interactive TUI. */
import { failStartup } from "../fail.ts";
import { enterAgentCommand } from "../shared.ts";

export async function runChat(
  dirArg: string,
  opts: { model?: string; session?: string; sessionsDir?: string },
): Promise<void> {
  // Chat authenticates through fastagent's credential store like every other command (the shared session builder
  // injects it — see engines/pi/session-builder.ts), so the first-run picker and its inline login apply here too.
  const placement = await enterAgentCommand(dirArg, opts);
  // Run the chat process AT the workspace: pi resolves a session's cwd as `header.cwd ?? process.cwd()`, so aligning
  // process.cwd() with the workspace keeps a cwd-less session on it.
  process.chdir(placement.workspace);
  // Lazy-import: chat pulls pi's interactive TUI module graph; headless start/dev never need it.
  const { runPiChat } = await import("../../engines/pi/chat.ts");
  // A served session is opened as a COPY (engines/pi/chat.ts): the record a serve owns is never opened for append.
  // WHERE to look for it is the CLI's knob to resolve — the same way the serve resolved it, or a serve started with
  // --sessions-dir has no session this command can find.
  let open: { session: string; sessionsDir: string } | undefined;
  if (opts.session !== undefined) {
    const { resolveSessionsDir } = await import("../../engines/pi/config.ts");
    open = { session: opts.session, sessionsDir: resolveSessionsDir(placement.agentDir, opts.sessionsDir) };
  }
  await runPiChat(placement.workspace, { model: opts.model }, open).catch(failStartup);
}
