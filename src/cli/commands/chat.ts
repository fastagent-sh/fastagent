/** `fastagent chat [dir]`: open the SAME assembled agent in pi's interactive TUI. */
import { failStartup, failUsage } from "../fail.ts";
import { enterAgentCommand } from "../shared.ts";

export async function runChat(
  dirArg: string,
  opts: { model?: string; session?: string; sessionsDir?: string },
): Promise<void> {
  // Chat authenticates through fastagent's credential store like every other command (the shared session builder
  // injects it — see engines/pi/session-builder.ts), so the first-run picker and its inline login apply here too.
  // A plain `chat` keeps its own sessions in pi's per-workspace location, so this knob only decides where a SERVED
  // one is looked for. Alone it would change nothing at all — say so instead of accepting it silently.
  if (opts.sessionsDir !== undefined && opts.session === undefined) {
    failUsage("--sessions-dir only applies with --session (it says where to look for a served session)");
  }
  const placement = await enterAgentCommand(dirArg, opts);
  // A served session is opened as a COPY (engines/pi/chat.ts): the record a serve owns is never opened for append.
  // WHERE to look for it is the CLI's knob to resolve, and it is resolved BEFORE the chdir below: a relative
  // `--sessions-dir` or `FASTAGENT_SESSIONS_DIR` means the same directory `start`/`info` mean — relative to where the
  // user is standing — and chdir'ing first would silently make it relative to the workspace instead.
  let open: { session: string; sessionsDir: string } | undefined;
  if (opts.session !== undefined) {
    const { resolveSessionsDir } = await import("../../engines/pi/config.ts");
    open = { session: opts.session, sessionsDir: resolveSessionsDir(placement.agentDir, opts.sessionsDir) };
  }
  // Run the chat process AT the workspace: pi resolves a session's cwd as `header.cwd ?? process.cwd()`, so aligning
  // process.cwd() with the workspace keeps a cwd-less session on it.
  process.chdir(placement.workspace);
  // Lazy-import: chat pulls pi's interactive TUI module graph; headless start/dev never need it.
  const { runPiChat } = await import("../../engines/pi/chat.ts");
  await runPiChat(placement.workspace, { model: opts.model }, open).catch(failStartup);
}
