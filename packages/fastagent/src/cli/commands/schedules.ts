/**
 * `fastagent schedules` — the agent's clock, operated: `run` fires a schedule now, `unwake` cancels a wake-up. Each goes
 * through the process that owns the instance (owner.ts): a deployment's (`--url`), the local serve's, or, with neither,
 * this process holding the instance itself. What will fire, and when, is `info`'s.
 */
import { resolve } from "node:path";
import { type Agent, AgentError, type Message, hasEnded } from "@fastagent-sh/client/agent-api";
import { connectAgent } from "@fastagent-sh/client";
import { buildDefinitionShape, loadSourceDefinition } from "../../harnesses/pi-durable/open.ts";
import { holdingInstance, openServing } from "../../harnesses/pi-durable/serve.ts";
import { enteredInstanceName } from "../../instance-name.ts";
import { resolveStateRoot } from "../../paths.ts";
import { removeAnyWakeup } from "../../schedule/wakeups.ts";
import { deploymentAgent } from "../deployment.ts";
import { agentDirOrExit, failStartup, failUsage } from "../fail.ts";
import { exitCodeOf } from "../invoke-stream.ts";
import { type InstanceFlags, enterInstance, instanceInputs, refuseUnnamedDatabaseInstance } from "../instance.ts";
import { type Owner, reachOwner } from "../owner.ts";
import { enterAgentCommand, reportAuth } from "../shared.ts";

export interface ClockOptions {
  instance?: InstanceFlags;
  /** A served instance's Agent API, and the key to call it with. */
  url?: string;
  key?: string;
}

/** A refusal as the line an operator reads: its code, then what it says. */
const refusal = (error: unknown) =>
  error instanceof AgentError ? new Error(`${error.code}: ${error.message}`) : error;

/** The instance's owner, when one serves it: the deployment `--url` names, or the local serve of the instance here. */
async function servedAgent(dirArg: string, opts: ClockOptions): Promise<Agent | undefined> {
  if (opts.url !== undefined) return deploymentAgent(dirArg, opts.url, opts.key, opts.instance);
  if (opts.key !== undefined) failUsage("--key is the key --url calls with: pass --url too");
  const target = agentDirOrExit(resolve(dirArg));
  enterInstance(target, opts.instance);
  const owner: Owner | undefined = await reachOwner(resolveStateRoot(target)).catch(failStartup);
  return owner === undefined ? undefined : connectAgent(owner.url, { apiKey: owner.key });
}

/** Wait for the fire's message to end, print its answer, and exit as `invoke` does: 0 only for `completed`. */
async function reportFire(agent: Agent, name: string, message: Message, close: () => Promise<void>): Promise<never> {
  let now = message;
  while (!hasEnded(now)) {
    now = await agent.messages.get({ sessionId: now.sessionId, messageId: now.id }, { wait: 60 }).catch(failStartup);
  }
  if (now.answer !== undefined) process.stdout.write(`${now.answer.text}\n`);
  await close();
  // The claim counts a cut-off answer as completed; the exit code does not.
  if (now.status === "incomplete") console.error(`[fastagent] ${name}: its answer was cut off (incomplete)`);
  process.exit(exitCodeOf(now));
}

/** Fire the schedule `name` now, as its clock would, through whatever owns the instance. */
export async function runScheduleNow(
  name: string,
  dirArg: string,
  opts: ClockOptions & { model?: string; input?: boolean },
): Promise<void> {
  const served = await servedAgent(dirArg, opts);
  if (served !== undefined) {
    if (opts.model !== undefined) failUsage("a served instance fires with the model it serves: drop --model");
    const fired = await served.schedules.run(name).catch((error: unknown) => failStartup(refusal(error)));
    if (fired.status === "skipped") failStartup(new Error(`${name} did not fire: ${fired.reason}`));
    return reportFire(served, name, fired.message, async () => {});
  }
  // The name before the model, from the definition's shape: a script told its schedule does not exist need not set up
  // a model first.
  const { agentDir, modelSpec } = await enterAgentCommand(dirArg, opts, async (target) => {
    const declared = await loadSourceDefinition(target)
      .then((definition) => buildDefinitionShape(definition, process.env).schedules.map((s) => s.name))
      .catch(failStartup);
    if (!declared.includes(name)) {
      failUsage(`no schedule "${name}" in ${target}/src/schedules/ (declared: ${declared.join(", ") || "none"})`);
    }
  });
  // Refused while the instance holds work a stopped serve left: this process would run it, and cut it off at its exit.
  const { agent, models } = await loadSourceDefinition(agentDir)
    .then((definition) =>
      openServing(definition, { model: modelSpec, ...instanceInputs(agentDir), unfinished: "refuse" }),
    )
    .catch(failStartup);
  await reportAuth(models, modelSpec, agentDir);
  const fired = await agent.schedules.run(name).catch(async (error: unknown) => {
    await agent.close();
    return failStartup(refusal(error));
  });
  if (fired.status === "skipped") {
    await agent.close();
    failStartup(new Error(`${name} did not fire: ${fired.reason}`));
  }
  return reportFire(agent, name, fired.message, () => agent.close());
}

/**
 * Cancel the pending wake-up `id`, whatever session set it: the one way out of a wake-up set where nobody can message
 * the agent (a schedule's own session). With no serve of the instance, this process holds its storage while it writes.
 */
export async function runUnwake(id: string, dirArg: string, opts: ClockOptions): Promise<void> {
  const served = await servedAgent(dirArg, opts);
  const removed =
    served !== undefined
      ? await served.wakeups.cancel(id).catch((error: unknown) => failStartup(refusal(error)))
      : await (async () => {
          refuseUnnamedDatabaseInstance();
          const stateRoot = resolveStateRoot(agentDirOrExit(resolve(dirArg)));
          const name = enteredInstanceName();
          const place = { stateRoot, env: process.env, ...(name === undefined ? {} : { name }) };
          const held = await holdingInstance(place, () => removeAnyWakeup(stateRoot, id)).catch(failStartup);
          if (held === undefined) failStartup(new Error(`no pending wake-up ${id} (state: ${stateRoot})`));
          return { id: held.id, fireAt: held.fireAt, sessionId: held.session, prompt: held.prompt };
        })();
  console.log(
    `removed wake ${removed.id}  ${removed.fireAt}  session=${removed.sessionId}  ${removed.prompt.slice(0, 60)}`,
  );
}
