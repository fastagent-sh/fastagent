/** `fastagent invoke <message> [agent]`: send ONE message to the opened agent, print its answer, then exit. */
import { stream } from "../../agent-api-stream.ts";
import { newSession } from "../../conversation-sessions.ts";
import { openServing } from "../../harnesses/pi-durable/serve.ts";
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
  // Its own storage, in memory: a serve of this directory owns the instance's.
  const { agent, models } = await openServing(agentDir, { model: modelSpec, locking: "memory" }).catch(failStartup);
  console.error(`[fastagent] invoke: ${agentDir} (${modelSpec})`);
  await reportAuth(models, modelSpec, agentDir);
  const sessionId = await newSession(agent).catch(failStartup);
  // runInvokeStream maps events→IO: reply→stdout, tool/failure→stderr, exit 1 unless the message completed (CI gates
  // on it).
  const exitCode = await runInvokeStream(
    await stream(agent, { sessionId, content: [{ type: "text", text: message }] }),
    (text) => process.stdout.write(text),
    (line) => console.error(line),
  );
  process.stdout.write("\n");
  await agent.close();
  // Always exit explicitly: the undici proxy agent's keep-alive sockets would otherwise hold the event loop open
  // after a successful one-shot message.
  process.exit(exitCode);
}
