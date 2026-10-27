/**
 * `fastagent invoke <message> [agent]`: send ONE message to the opened agent, print its answer, then exit. Every run
 * prints its session's id; `--session <id>` sends the message into that session, continuing it.
 */
import { join } from "node:path";
import { type Agent, AgentRejection, type SessionSettings } from "../../agent-api.ts";
import { stream } from "../../agent-api-stream.ts";
import { modelRefOf } from "../../harnesses/pi-durable/open.ts";
import { openServing } from "../../harnesses/pi-durable/serve.ts";
import { resolveStateRoot } from "../../paths.ts";
import { runInvokeJson, runInvokeStream } from "../invoke-stream.ts";
import { failStartup } from "../fail.ts";
import { enterAgentCommand, reportAuth } from "../shared.ts";

export interface InvokeOptions {
  model?: string;
  /** false ⇔ `--no-input`. */
  input?: boolean;
  json?: boolean;
  session?: string;
}

/**
 * `invoke`'s sessions, apart from the instance's storage, so `invoke` runs beside a serve of this directory, which holds
 * that one; one `invoke` at a time holds this one.
 */
const invokeStorageFile = (stateRoot: string) => join(stateRoot, "invoke.sqlite");

/**
 * The session to send into, a new one or `sessionId`, set to the model this run resolved: every run answers with the
 * model its flags and configuration name, a continued session included.
 */
async function sessionFor(agent: Agent, sessionId: string | undefined, settings: SessionSettings, file: string) {
  if (sessionId === undefined) {
    const created = await agent.createSession(settings);
    if (!created.ok) throw new AgentRejection(created.error);
    return created.sessionId;
  }
  const configured = await agent.configure(sessionId, settings);
  if (configured.ok) return sessionId;
  if (configured.error.code === "not_found") {
    throw new Error(`--session ${sessionId}: no such session in ${file}; pass an id an earlier invoke printed`);
  }
  throw new AgentRejection(configured.error);
}

export async function runInvoke(message: string, dirArg: string, opts: InvokeOptions): Promise<void> {
  const { agentDir, modelSpec } = await enterAgentCommand(dirArg, opts);
  const file = invokeStorageFile(resolveStateRoot(agentDir));
  const { agent, models, definition } = await openServing(agentDir, {
    model: modelSpec,
    storage: { file, holders: "another `fastagent invoke` of this agent" },
  }).catch(failStartup);
  console.error(`[fastagent] invoke: ${agentDir} (${modelSpec})`);
  await reportAuth(models, modelSpec, agentDir);
  const { thinkingLevel } = definition.config;
  const settings = {
    model: modelRefOf(modelSpec, "the model"),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
  };
  const sessionId = await sessionFor(agent, opts.session, settings, file).catch(failStartup);
  console.error(`[fastagent] session ${sessionId} (continue it with --session ${sessionId})`);
  const result = await stream(agent, { sessionId, content: [{ type: "text", text: message }] });
  // Both renderers exit 1 unless the message completed: CI gates on it.
  const exitCode = opts.json
    ? await runInvokeJson(result, (line) => process.stdout.write(`${line}\n`))
    : await runInvokeStream(
        result,
        (text) => process.stdout.write(text),
        (line) => console.error(line),
      );
  if (!opts.json) process.stdout.write("\n");
  await agent.close();
  // Always exit explicitly: the undici proxy agent's keep-alive sockets would otherwise hold the event loop open
  // after a successful one-shot message.
  process.exit(exitCode);
}
