/** `fastagent invoke <message> [dir]`: run ONE turn against the assembled agent, then exit. */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { loadDotEnv } from "../../env.ts";
import { resolveWorkspace } from "../../engines/pi/config.ts";
import { createPiAgentFromWorkspace } from "../../engines/pi/workspace.ts";
import { runInvokeStream } from "../invoke-stream.ts";
import { installProxyFetch } from "../../proxy.ts";
import { failStartup, failStartupOn } from "../fail.ts";
import { reportAuth, resolveFirstRunModel } from "../shared.ts";

export interface InvokeOptions {
  model?: string;
  authPath?: string;
  /** false ⇔ `--no-input`. */
  input?: boolean;
}

export async function runInvoke(message: string, dirArg: string, opts: InvokeOptions): Promise<void> {
  const invokeDir = resolve(dirArg);
  const ws = failStartupOn(() => resolveWorkspace(invokeDir));
  loadDotEnv(ws.root);
  installProxyFetch();
  await resolveFirstRunModel(ws.root, opts);
  const { agent, modelSpec, authPath } = await createPiAgentFromWorkspace(invokeDir, {
    model: opts.model,
    authPath: opts.authPath, // flag > FASTAGENT_AUTH_PATH > default — resolved by the opener (one owner)
  }).catch(failStartup);
  console.error(`[fastagent] invoke: ${ws.workbench} (${modelSpec})`);
  await reportAuth(modelSpec, authPath);
  // Fresh session per invoke (one-shot, no resume). runInvokeStream maps events→IO: reply→stdout,
  // tool/failure→stderr, exit 1 iff the turn failed (so CI can gate on it).
  const exitCode = await runInvokeStream(
    agent.invoke({ session: randomUUID() }, { text: message }),
    (text) => process.stdout.write(text),
    (line) => console.error(line),
  );
  process.stdout.write("\n");
  // Always exit explicitly: the undici proxy agent's keep-alive sockets would otherwise hold the
  // event loop open after a successful one-shot turn.
  process.exit(exitCode);
}
