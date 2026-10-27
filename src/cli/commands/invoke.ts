/**
 * `fastagent invoke <message> [agent]`: send ONE message to the opened agent, print its answer, then exit. With
 * `--session <name>`, the message continues the conversation of that name, kept between runs.
 */
import { join } from "node:path";
import { type Agent, AgentRejection, type SessionSettings } from "../../agent-api.ts";
import { stream } from "../../agent-api-stream.ts";
import { modelRefOf } from "../../harnesses/pi-durable/open.ts";
import { openServing } from "../../harnesses/pi-durable/serve.ts";
import { resolveStateRoot } from "../../paths.ts";
import { runInvokeJson, runInvokeStream } from "../invoke-stream.ts";
import { failStartup, failUsage } from "../fail.ts";
import { enterAgentCommand, reportAuth } from "../shared.ts";

export interface InvokeOptions {
  model?: string;
  /** false ⇔ `--no-input`. */
  input?: boolean;
  json?: boolean;
  session?: string;
}

const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * A named conversation is a database of its own, so it never meets the storage a serve of this directory holds, and
 * two conversations run side by side.
 */
const conversationFile = (stateRoot: string, name: string) => join(stateRoot, "invoke", `${name}.sqlite`);

/**
 * The conversation's one session, the one its database holds or a new one, set to the model this run resolved: every
 * run answers with the model its flags and configuration name, a continued conversation included.
 */
async function conversationSession(agent: Agent, settings: SessionSettings): Promise<string> {
  const listed = await agent.listSessions({ limit: 1 });
  if (!listed.ok) throw new AgentRejection(listed.error);
  const kept = listed.sessions[0]?.sessionId;
  if (kept === undefined) {
    const created = await agent.createSession(settings);
    if (!created.ok) throw new AgentRejection(created.error);
    return created.sessionId;
  }
  const configured = await agent.configure(kept, settings);
  if (!configured.ok) throw new AgentRejection(configured.error);
  return kept;
}

export async function runInvoke(message: string, dirArg: string, opts: InvokeOptions): Promise<void> {
  const name = opts.session;
  if (name !== undefined && !SESSION_NAME.test(name)) {
    failUsage(`--session ${JSON.stringify(name)}: a name of letters, digits, ".", "_" and "-", at most 128`);
  }
  const { agentDir, modelSpec } = await enterAgentCommand(dirArg, opts);
  const file = name === undefined ? undefined : conversationFile(resolveStateRoot(agentDir), name);
  const { agent, models, definition } = await openServing(agentDir, {
    model: modelSpec,
    storage:
      file === undefined ? "memory" : { file, holders: `another \`fastagent invoke --session ${name}\` of this agent` },
  }).catch(failStartup);
  console.error(
    `[fastagent] invoke: ${agentDir} (${modelSpec})${file === undefined ? "" : `, session ${name}: ${file}`}`,
  );
  await reportAuth(models, modelSpec, agentDir);
  const { thinkingLevel } = definition.config;
  const sessionId = await conversationSession(agent, {
    model: modelRefOf(modelSpec, "the model"),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
  }).catch(failStartup);
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
