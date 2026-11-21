/**
 * `fastagent schedules` — the agent's clock, read and operated: `list` says what fires next, how each schedule last ran
 * and which wake-ups are pending; `run` fires a schedule now; `unwake` cancels a wake-up. Each goes through the process
 * that owns the instance (owner.ts): a deployment's (`--url`), the local serve's, or, with neither, this process
 * holding the instance itself.
 */
import { resolve } from "node:path";
import {
  type Agent,
  AgentError,
  type ClockApi,
  type Message,
  type ScheduleState,
  type Wakeup,
  hasEnded,
} from "@fastagent-sh/client/agent-api";
import { connectAgent, connectClock } from "@fastagent-sh/client";
import { buildDefinitionShape, loadSourceDefinition } from "../../harnesses/pi-durable/open.ts";
import { resolveHarnessSelection } from "../../harnesses/pi-durable/config.ts";
import { openServing, withInstanceClock } from "../../harnesses/serving.ts";
import { enteredInstanceName } from "../../instance-name.ts";
import { resolveStateRoot } from "../../paths.ts";
import { pendingWakeups, scheduleStates } from "../../schedule/operations.ts";
import { removeAnyWakeup } from "../../schedule/wakeups.ts";
import { resolveRemoteTarget } from "../deployment.ts";
import { agentDirOrExit, failStartup, failUsage } from "../fail.ts";
import { exitCodeOf } from "../invoke-stream.ts";
import { type InstanceFlags, enterInstance, instanceInputs, refuseUnnamedDatabaseInstance } from "../instance.ts";
import { type Owner, reachOwner } from "../owner.ts";
import { enterAgentCommand, reportAuth } from "../shared.ts";

export interface ClockOptions {
  instance?: InstanceFlags;
  harness?: string;
  sandbox?: string;
  /** A served instance's Agent API, named by `--url` or `--remote`, and optional key override. */
  url?: string;
  remote?: string;
  key?: string;
}

/** A refusal as the line an operator reads: its code, then what it says. */
const refusal = (error: unknown) =>
  error instanceof AgentError ? new Error(`${error.code}: ${error.message}`) : error;

/** The instance's owner, when one serves it: `--url` / `--remote`, or the local serve of the instance here. */
async function servedOwner(dirArg: string, opts: ClockOptions): Promise<{ agent: Agent; clock: ClockApi } | undefined> {
  const remoteTarget = await resolveRemoteTarget(dirArg, opts, opts.instance);
  if (remoteTarget !== undefined) return { agent: remoteTarget.agent, clock: remoteTarget.clock };
  const target = agentDirOrExit(resolve(dirArg));
  enterInstance(target, opts.instance);
  const owner: Owner | undefined = await reachOwner(resolveStateRoot(target)).catch(failStartup);
  return owner === undefined
    ? undefined
    : { agent: connectAgent(owner.url, { apiKey: owner.key }), clock: connectClock(owner.url, { apiKey: owner.key }) };
}

/** The clock as the Clock API says it, through whatever owns the instance. */
async function readClock(
  dirArg: string,
  opts: ClockOptions,
): Promise<{ schedules: ScheduleState[]; wakeups: Wakeup[] }> {
  const served = await servedOwner(dirArg, opts);
  if (served !== undefined) {
    const [schedules, wakeups] = await Promise.all([served.clock.schedules.list(), served.clock.wakeups.list()]).catch(
      (error: unknown) => failStartup(refusal(error)),
    );
    return { schedules, wakeups };
  }
  refuseUnnamedDatabaseInstance();
  const agentDir = agentDirOrExit(resolve(dirArg));
  const definition = await loadSourceDefinition(agentDir).catch(failStartup);
  const selection = (() => {
    try {
      return resolveHarnessSelection(definition.config, {
        ...(opts.harness === undefined ? {} : { harness: opts.harness }),
        ...(opts.sandbox === undefined ? {} : { sandbox: opts.sandbox }),
      });
    } catch (error) {
      return failUsage(error instanceof Error ? error.message : String(error));
    }
  })();
  const { schedules } = buildDefinitionShape(definition, process.env);
  const name = enteredInstanceName();
  const place = {
    stateRoot: resolveStateRoot(agentDir),
    env: process.env,
    agent: definition.name,
    harness: selection.harness,
    ...(name === undefined ? {} : { name }),
  };
  return withInstanceClock(place, async (clock) => ({
    schedules: await scheduleStates(clock, schedules),
    wakeups: await pendingWakeups(clock),
  })).catch(failStartup);
}

/** List what fires next, how each schedule last ran, and the pending wake-ups. */
export async function runList(dirArg: string, opts: ClockOptions & { json?: boolean }): Promise<void> {
  const clock = await readClock(dirArg, opts);
  if (opts.json) {
    console.log(JSON.stringify(clock, null, 2));
    return;
  }
  console.log(clock.schedules.length === 0 ? "schedules: (none)" : "schedules:");
  for (const s of clock.schedules) {
    const last = s.last === undefined ? "never run" : `last ${s.last.outcome ?? "running"} at ${s.last.firedAt}`;
    console.log(`  ${s.name}  "${s.cron}"${s.tz ? ` ${s.tz}` : ""}  next ${s.next ?? "never"}  ${last}`);
  }
  console.log(clock.wakeups.length === 0 ? "wake-ups: (none)" : "wake-ups:");
  for (const w of clock.wakeups) {
    console.log(
      `  ${w.id}  ${w.fireAt}${w.cron ? ` "${w.cron}"` : ""}  session=${w.sessionId}  ${w.prompt.slice(0, 60)}`,
    );
  }
}

/** Wait for the fire's message to end, print its answer (or Message JSON), and exit as `invoke` does: 0 only for `completed`. */
async function reportFire(
  agent: Agent,
  name: string,
  message: Message,
  close: () => Promise<void>,
  json?: boolean,
): Promise<never> {
  let now = message;
  while (!hasEnded(now)) {
    now = await agent.messages.get({ sessionId: now.sessionId, messageId: now.id }, { wait: 60 }).catch(failStartup);
  }
  if (json) console.log(JSON.stringify(now, null, 2));
  else if (now.answer !== undefined) process.stdout.write(`${now.answer.text}\n`);
  await close();
  // The claim counts a cut-off answer as completed; the exit code does not.
  if (!json && now.status === "incomplete") console.error(`[fastagent] ${name}: its answer was cut off (incomplete)`);
  process.exit(exitCodeOf(now));
}

/** Fire the schedule `name` now, as its clock would, through whatever owns the instance. */
export async function runScheduleNow(
  name: string,
  dirArg: string,
  opts: ClockOptions & { model?: string; harness?: string; sandbox?: string; input?: boolean; json?: boolean },
): Promise<void> {
  const served = await servedOwner(dirArg, opts);
  if (served !== undefined) {
    if (opts.model !== undefined) failUsage("a served instance fires with the model it serves: drop --model");
    const fired = await served.clock.schedules.run(name).catch((error: unknown) => failStartup(refusal(error)));
    if (fired.status === "skipped") failStartup(new Error(`${name} did not fire: ${fired.reason}`));
    return reportFire(served.agent, name, fired.message, async () => {}, opts.json);
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
  const { agent, clock, models } = await loadSourceDefinition(agentDir)
    .then((definition) => {
      const selection = resolveHarnessSelection(definition.config, {
        ...(opts.harness === undefined ? {} : { harness: opts.harness }),
        ...(opts.sandbox === undefined ? {} : { sandbox: opts.sandbox }),
      });
      return openServing(definition, {
        model: modelSpec,
        harness: selection.harness,
        ...(selection.sandbox === undefined ? {} : { sandbox: selection.sandbox }),
        ...instanceInputs(agentDir),
        unfinished: "refuse",
      });
    })
    .catch(failStartup);
  await reportAuth(models, modelSpec, agentDir);
  if (clock === undefined) {
    await agent.close();
    failStartup(new Error(`the instance has no clock to run schedule "${name}"`));
  }
  const fired = await clock.api.schedules.run(name).catch(async (error: unknown) => {
    await agent.close();
    return failStartup(refusal(error));
  });
  if (fired.status === "skipped") {
    await agent.close();
    failStartup(new Error(`${name} did not fire: ${fired.reason}`));
  }
  return reportFire(agent, name, fired.message, () => agent.close(), opts.json);
}

/**
 * Cancel the pending wake-up `id`, whatever session set it: the one way out of a wake-up set where nobody can message
 * the agent (a schedule's own session). With no serve of the instance, this process holds its storage while it writes.
 */
export async function runUnwake(id: string, dirArg: string, opts: ClockOptions): Promise<void> {
  const served = await servedOwner(dirArg, opts);
  const removed =
    served !== undefined
      ? await served.clock.wakeups.cancel(id).catch((error: unknown) => failStartup(refusal(error)))
      : await (async () => {
          refuseUnnamedDatabaseInstance();
          const agentDir = agentDirOrExit(resolve(dirArg));
          const definition = await loadSourceDefinition(agentDir).catch(failStartup);
          const selection = (() => {
            try {
              return resolveHarnessSelection(definition.config, {
                ...(opts.harness === undefined ? {} : { harness: opts.harness }),
                ...(opts.sandbox === undefined ? {} : { sandbox: opts.sandbox }),
              });
            } catch (error) {
              return failUsage(error instanceof Error ? error.message : String(error));
            }
          })();
          const stateRoot = resolveStateRoot(agentDir);
          const name = enteredInstanceName();
          const place = {
            stateRoot,
            env: process.env,
            harness: selection.harness,
            ...(name === undefined ? {} : { name }),
          };
          const held = await withInstanceClock(place, (clock) => removeAnyWakeup(clock, id)).catch(failStartup);
          if (held === undefined) failStartup(new Error(`no pending wake-up ${id} (state: ${stateRoot})`));
          return { id: held.id, fireAt: held.fireAt, sessionId: held.session, prompt: held.prompt };
        })();
  console.log(
    `removed wake ${removed.id}  ${removed.fireAt}  session=${removed.sessionId}  ${removed.prompt.slice(0, 60)}`,
  );
}
