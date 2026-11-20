/**
 * `fastagent invoke [message]`: send ONE message (positional, `-`, or piped stdin) to the opened agent, print its answer, then exit. Every run
 * prints its session's id; `--session <id>` sends the message into that session, continuing it. `--url` sends it to a
 * served agent instead, over its Agent API, with the same output and exit code.
 */
import { type Agent, AgentError, type MessageStreamEvent, type SessionSettings } from "@fastagent-sh/client/agent-api";
import { modelRefOf } from "../../model-ref.ts";
import { connectAgent } from "@fastagent-sh/client";
import { resolveStateRoot } from "../../paths.ts";
import { runInvokeJson, runInvokeStream } from "../invoke-stream.ts";
import { reachOwner } from "../owner.ts";
import { failStartup, failUsage } from "../fail.ts";
import { resolveRemoteTarget } from "../deployment.ts";
import { type InstanceFlags, instanceInputs } from "../instance.ts";

export interface InvokeOptions {
  model?: string;
  /** false ⇔ `--no-input`. */
  input?: boolean;
  json?: boolean;
  session?: string;
  /** A served agent's base URL: the message goes there, over its Agent API. */
  url?: string;
  /** A named remote from ~/.config/fastagent/remotes.json. */
  remote?: string;
  /** The key `url` or `remote` is called with; else the first `FASTAGENT_API_KEY` of the environment. */
  key?: string;
  instance?: InstanceFlags;
}

/**
 * The session to send into, a new one or `sessionId`, set to the model this run resolved: every run answers with the
 * model its flags and configuration name, a continued session included.
 */
async function sessionFor(agent: Agent, sessionId: string | undefined, settings: SessionSettings, where: string) {
  if (sessionId === undefined) return (await agent.sessions.create(settings)).id;
  await agent.sessions.update(sessionId, settings).catch((error: unknown) => {
    if (error instanceof AgentError && error.code === "not_found") {
      throw new Error(`--session ${sessionId}: no such session in ${where}; pass an id an earlier invoke printed`);
    }
    throw error;
  });
  return sessionId;
}

/** A refusal as the line an operator reads: its code, then what it says. */
const refusal = (error: unknown) =>
  error instanceof AgentError ? new Error(`${error.code}: ${error.message}`) : error;

/** Print the message's answer as it is written, then exit with what it ended as: 0 only for `completed`. */
/** What to do about a model with no credential, where the answer came from. */
const LOCAL_AUTH_HINT = "sign in with `fastagent login`, or set the provider's API key in .secrets/.env";
const DEPLOYED_AUTH_HINT = "set the provider's API key in the deployment's environment";

async function answer(
  events: AsyncIterable<MessageStreamEvent>,
  json: boolean | undefined,
  authHint: string,
): Promise<number> {
  // Both renderers exit 1 unless the message completed: CI gates on it.
  const exitCode = json
    ? await runInvokeJson(events, (line) => process.stdout.write(`${line}\n`))
    : await runInvokeStream(
        events,
        (text) => process.stdout.write(text),
        (line) => console.error(line),
        authHint,
      );
  if (!json) process.stdout.write("\n");
  return exitCode;
}

/** `--url` / `--remote`: send through a served agent's Agent API; nothing opens locally. */
async function runRemoteInvoke(
  message: string,
  target: { agent: Agent; label: string; defaultSessionId?: string },
  opts: InvokeOptions,
) {
  let settings: SessionSettings | undefined;
  try {
    settings = opts.model === undefined ? undefined : { model: modelRefOf(opts.model, "--model") };
  } catch (error) {
    failUsage(error instanceof Error ? error.message : String(error));
  }
  const effectiveOpts =
    opts.session === undefined && target.defaultSessionId !== undefined
      ? { ...opts, session: target.defaultSessionId }
      : opts;
  await invokeThrough(target.agent, target.label, message, effectiveOpts, settings, DEPLOYED_AUTH_HINT);
}

/** Options for sending one message over an Agent API client (`invoke --url`, `agentcore invoke`, local serve). */
export interface InvokeOverApiOptions {
  session?: string;
  settings?: SessionSettings;
  json?: boolean;
  authHint: string;
  /** The flags printed after `continue it with …`; defaults to `--session <sessionId>`. */
  continueFlags?: (sessionId: string) => string;
}

/**
 * Send one message through an Agent API client (`agent`), stream its answer to stdout (text or NDJSON) and progress to
 * stderr, and return the CLI exit code (0 only for `completed`). Throws on session lookup/creation refusal.
 */
export async function invokeOverApi(
  agent: Agent,
  where: string,
  message: string,
  opts: InvokeOverApiOptions,
): Promise<number> {
  console.error(`[fastagent] invoke: ${where}`);
  const sessionId = await remoteSession(agent, opts.session, opts.settings, where).catch((error: unknown) => {
    throw refusal(error);
  });
  const flags = opts.continueFlags ? opts.continueFlags(sessionId) : `--session ${sessionId}`;
  console.error(`[fastagent] session ${sessionId} (continue it with ${flags})`);
  return answer(agent.messages.stream({ sessionId, content: message }), opts.json, opts.authHint);
}

/** Send `message` through the Agent API of a served instance: a deployment's, or the local serve that owns this one. */
async function invokeThrough(
  agent: Agent,
  where: string,
  message: string,
  opts: InvokeOptions,
  settings: SessionSettings | undefined,
  authHint: string,
): Promise<never> {
  const exitCode = await invokeOverApi(agent, where, message, {
    session: opts.session,
    settings,
    json: opts.json,
    authHint,
  }).catch(failStartup);
  process.exit(exitCode);
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

/**
 * Resolve one invoke message from a positional argument, `-`, or piped stdin.
 * Returns `{ ok: false, error }` instead of exiting so every caller reports usage errors in its own format.
 */
export async function readInvokeMessage(
  given: string | undefined,
  command = "fastagent invoke",
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  if (given !== undefined && given !== "-") {
    if (given.trim() === "") return { ok: false, error: "message must not be empty" };
    return { ok: true, message: given };
  }
  if (given === undefined && process.stdin.isTTY === true) {
    return { ok: false, error: `missing message: pass <message> or pipe stdin (e.g. echo "hi" | ${command})` };
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  const piped = Buffer.concat(chunks).toString("utf8");
  if (piped.trim() === "") {
    return { ok: false, error: "missing message: pass <message> or pipe non-empty stdin" };
  }
  return { ok: true, message: piped.replace(/\r?\n$/, "") };
}

export async function runInvoke(given: string | undefined, dirArg: string, opts: InvokeOptions): Promise<void> {
  if (opts.url !== undefined && opts.remote !== undefined) {
    failUsage("pass either --url or --remote, not both");
  }
  if (opts.url === undefined && opts.remote === undefined && opts.key !== undefined) {
    failUsage("--key is the key --url or --remote calls with: pass --url or --remote too");
  }
  const input = await readInvokeMessage(given);
  if (!input.ok) failUsage(input.error);
  const message = input.message;
  if (opts.url !== undefined || opts.remote !== undefined) {
    const remoteTarget = await resolveRemoteTarget(dirArg, opts, opts.instance);
    if (remoteTarget !== undefined) return runRemoteInvoke(message, remoteTarget, opts);
  }
  const [{ openServing }, { loadSourceDefinition }, { enterAgentCommand, reportAuth }] = await Promise.all([
    import("../../harnesses/pi-durable/serve.ts"),
    import("../../harnesses/pi-durable/open.ts"),
    import("../shared.ts"),
  ]);
  const { agentDir, modelSpec } = await enterAgentCommand(dirArg, opts, async (target) => {
    // A running serve of this instance owns its storage and answers with its own model: the message goes through it
    // (owner.ts), before any model is asked for here.
    const owner = await reachOwner(resolveStateRoot(target)).catch(failStartup);
    if (owner === undefined) return;
    let settings: SessionSettings | undefined;
    try {
      settings = opts.model === undefined ? undefined : { model: modelRefOf(opts.model, "--model") };
    } catch (error) {
      failUsage(error instanceof Error ? error.message : String(error));
    }
    const agent = connectAgent(owner.url, { apiKey: owner.key });
    await invokeThrough(
      agent,
      `${target}, through its serve at ${owner.url}`,
      message,
      opts,
      settings,
      LOCAL_AUTH_HINT,
    );
  });
  const stateRoot = resolveStateRoot(agentDir);
  const definition = await loadSourceDefinition(agentDir).catch(failStartup);
  const { agent, models, config } = await openServing(definition, {
    model: modelSpec,
    ...instanceInputs(agentDir),
    // What an earlier serve accepted is a serve's to finish: this process would cut it off at its exit.
    unfinished: "refuse",
  }).catch(failStartup);
  console.error(`[fastagent] invoke: ${agentDir} (${modelSpec})`);
  await reportAuth(models, modelSpec, agentDir);
  const { thinkingLevel } = config;
  const settings = {
    model: modelRefOf(modelSpec, "the model"),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
  };
  const sessionId = await sessionFor(agent, opts.session, settings, stateRoot).catch(failStartup);
  console.error(`[fastagent] session ${sessionId} (continue it with --session ${sessionId})`);
  const exitCode = await answer(agent.messages.stream({ sessionId, content: message }), opts.json, LOCAL_AUTH_HINT);
  await agent.close();
  // Always exit explicitly: the undici proxy agent's keep-alive sockets would otherwise hold the event loop open
  // after a successful one-shot message.
  process.exit(exitCode);
}
