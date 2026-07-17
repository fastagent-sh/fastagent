/** `fastagent chat [dir]`: open the SAME assembled agent in pi's interactive TUI. */
import { resolve } from "node:path";
import { loadDotEnv } from "../../env.ts";
import { installProxyFetch } from "../../proxy.ts";
import { failStartup } from "../fail.ts";

export async function runChat(dirArg: string, opts: { model?: string }): Promise<void> {
  const dir = resolve(dirArg);
  loadDotEnv(dir);
  installProxyFetch(); // model calls (and the login dialog) must go through the proxy too
  // Run the chat process IN the workspace: pi resolves a session's cwd as `header.cwd ?? process.cwd()`,
  // so aligning process.cwd() with the workspace keeps a cwd-less session on the workspace. `dir` is absolute.
  process.chdir(dir);
  // Lazy-import: chat pulls pi's interactive TUI module graph; headless start/dev never need it.
  const { runPiChat } = await import("../../engines/pi/chat.ts");
  await runPiChat(dir, { model: opts.model }).catch(failStartup);
}
