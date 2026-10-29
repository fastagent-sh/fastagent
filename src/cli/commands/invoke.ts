/**
 * `fastagent invoke <message> [agent]`: send ONE message to the opened agent, print its answer, then exit. Every run
 * prints its session's id; `--session <id>` sends the message into that session, continuing it. `--url` sends it to a
 * served agent instead, over its Agent API (agent-api.md §9.6), with the same output and exit code.
 */
import { join, relative, resolve } from "node:path";
import { type Agent, AgentError, type MessageStreamEvent, type SessionSettings } from "../../agent-api.ts";
import { dotEnvPath, loadEnvValues } from "../../env.ts";
import { modelRefOf } from "../../harnesses/pi-durable/open.ts";
import { openServing } from "../../harnesses/pi-durable/serve.ts";
import { connectAgent } from "../../http/client.ts";
import { API_KEY_VARIABLE, apiKeysFrom } from "../../http/server.ts";
import { resolveStateRoot, selectAgentEnvironment } from "../../paths.ts";
import { runInvokeJson, runInvokeStream } from "../invoke-stream.ts";
import { agentDirOrExit, failStartup, failUsage } from "../fail.ts";
import { enterAgentCommand, reportAuth } from "../shared.ts";

export interface InvokeOptions {
  model?: string;
  /** false ⇔ `--no-input`. */
  input?: boolean;
  json?: boolean;
  session?: string;
  /** A served agent's base URL: the message goes there, over its Agent API. */
  url?: string;
  /** The key `url` is called with; else the first in the agent's production values. */
  key?: string;
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
  if (sessionId === undefined) return (await agent.sessions.create(settings)).id;
  await agent.sessions.update(sessionId, settings).catch((error: unknown) => {
    if (error instanceof AgentError && error.code === "not_found") {
      throw new Error(`--session ${sessionId}: no such session in ${file}; pass an id an earlier invoke printed`);
    }
    throw error;
  });
  return sessionId;
}

/** A refusal as the line an operator reads: its code, then what it says. */
const refusal = (error: unknown) =>
  error instanceof AgentError ? new Error(`${error.code}: ${error.message}`) : error;

/** Print the message's answer as it is written, then exit with what it ended as: 0 only for `completed`. */
async function answer(events: AsyncIterable<MessageStreamEvent>, json: boolean | undefined): Promise<number> {
  // Both renderers exit 1 unless the message completed: CI gates on it.
  const exitCode = json
    ? await runInvokeJson(events, (line) => process.stdout.write(`${line}\n`))
    : await runInvokeStream(
        events,
        (text) => process.stdout.write(text),
        (line) => console.error(line),
      );
  if (!json) process.stdout.write("\n");
  return exitCode;
}

/**
 * The key `--url` calls with: `--key`, or the first of `FASTAGENT_API_KEY` in the agent's production values, which
 * `deploy` writes there and carries to the deployment.
 */
function deploymentKey(dirArg: string, url: string): string {
  const agentDir = agentDirOrExit(resolve(dirArg));
  selectAgentEnvironment("production");
  const file = dotEnvPath(agentDir);
  const [key] = apiKeysFrom(loadEnvValues(file).get(API_KEY_VARIABLE));
  if (key === undefined) {
    failUsage(
      `no key to call ${url} with: pass --key, or set ${API_KEY_VARIABLE} in ${relative(process.cwd(), file) || file} ` +
        "(deploy writes one there)",
    );
  }
  return key;
}

/** `--url`: the message sent to a served agent over its Agent API, in a session there; nothing opens here. */
async function runRemoteInvoke(message: string, dirArg: string, opts: InvokeOptions & { url: string }) {
  const { url } = opts;
  let settings: SessionSettings | undefined;
  try {
    settings = opts.model === undefined ? undefined : { model: modelRefOf(opts.model, "--model") };
  } catch (error) {
    failUsage(error instanceof Error ? error.message : String(error));
  }
  const agent = connectAgent(url, { apiKey: opts.key ?? deploymentKey(dirArg, url) });
  console.error(`[fastagent] invoke: ${url}`);
  const sessionId = await remoteSession(agent, opts.session, settings, url).catch((error: unknown) =>
    failStartup(refusal(error)),
  );
  console.error(`[fastagent] session ${sessionId} (continue it with --session ${sessionId})`);
  process.exit(await answer(agent.messages.stream({ sessionId, content: message }), opts.json));
}

/** The served agent's session to send into: a new one, or `sessionId`, set to `--model` when one is given. */
async function remoteSession(
  agent: Agent,
  sessionId: string | undefined,
  settings: SessionSettings | undefined,
  url: string,
): Promise<string> {
  if (sessionId === undefined) return (await agent.sessions.create(settings)).id;
  const found = settings === undefined ? agent.sessions.get(sessionId) : agent.sessions.update(sessionId, settings);
  await found.catch((error: unknown) => {
    if (error instanceof AgentError && error.code === "not_found") {
      throw new Error(`--session ${sessionId}: no such session at ${url}; pass an id an earlier invoke printed`);
    }
    throw error;
  });
  return sessionId;
}

export async function runInvoke(message: string, dirArg: string, opts: InvokeOptions): Promise<void> {
  if (opts.url !== undefined) return runRemoteInvoke(message, dirArg, { ...opts, url: opts.url });
  if (opts.key !== undefined) failUsage("--key is the key --url calls with: pass --url too");
  const { agentDir, modelSpec } = await enterAgentCommand(dirArg, opts);
  const file = invokeStorageFile(resolveStateRoot(agentDir));
  const { agent, models, definition } = await openServing(agentDir, {
    model: modelSpec,
    storage: { file, holders: "another `fastagent invoke` of this agent" },
    // Its messages do not outlive it: one a stopped invoke left is not run again by the next.
    unfinished: "abort",
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
  const exitCode = await answer(agent.messages.stream({ sessionId, content: message }), opts.json);
  await agent.close();
  // Always exit explicitly: the undici proxy agent's keep-alive sockets would otherwise hold the event loop open
  // after a successful one-shot message.
  process.exit(exitCode);
}
