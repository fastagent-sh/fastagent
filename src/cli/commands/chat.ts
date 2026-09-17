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
  const { resolveSessionsDir } = await import("../../engines/pi/config.ts");
  // A served session is opened as a COPY (engines/pi/chat.ts): the record a serve owns is never opened for append.
  // Its directory resolves the SAME way the serve resolved it (--sessions-dir > FASTAGENT_SESSIONS_DIR > default),
  // or a serve started with the flag has no session this command can find.
  const open =
    opts.session === undefined
      ? undefined
      : { session: opts.session, sessionsDir: resolveSessionsDir(placement.agentDir, opts.sessionsDir) };
  await runPiChat(placement.workspace, { model: opts.model }, open).catch(failStartup);
}
