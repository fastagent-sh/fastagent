/** `fastagent invoke <message> [agent]`: run ONE turn against the assembled agent, then exit. */
import { randomUUID } from "node:crypto";
import { createPiAgentFromDir } from "../../engines/pi/open.ts";
import { runInvokeStream } from "../invoke-stream.ts";
import { failStartup } from "../fail.ts";
import { enterAgentCommand, reportAuth } from "../shared.ts";

export interface InvokeOptions {
  model?: string;
  /** false ⇔ `--no-input`. */
  input?: boolean;
}

export async function runInvoke(message: string, dirArg: string, opts: InvokeOptions): Promise<void> {
  const { agentDir, modelSpec } = await enterAgentCommand(dirArg, opts);
  const { agent, models } = await createPiAgentFromDir(agentDir, { model: modelSpec }).catch(failStartup);
  console.error(`[fastagent] invoke: ${agentDir} (${modelSpec})`);
  await reportAuth(models, modelSpec, agentDir);
  // Fresh session per invoke (one-shot, no resume). runInvokeStream maps events→IO: reply→stdout,
  // tool/failure→stderr, exit 1 iff the turn failed (so CI can gate on it).
  const exitCode = await runInvokeStream(
    agent.invoke({ session: randomUUID() }, { text: message }),
    (text) => process.stdout.write(text),
    (line) => console.error(line),
  );
  process.stdout.write("\n");
  // Always exit explicitly: the undici proxy agent's keep-alive sockets would otherwise hold the event loop open
  // after a successful one-shot turn.
  process.exit(exitCode);
}
