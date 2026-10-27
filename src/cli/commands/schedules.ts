/**
 * `fastagent schedules` — what is going to wake this agent up: the schedules its definition declares, and the wake-ups
 * it set for itself. `list` shows both, `run` fires a schedule now, `unwake` cancels a wake-up.
 *
 * The two have different owners (a schedule is the definition's, a wake-up the state's) but answer the same operator
 * question, so one command lists both, labelled apart.
 */
import { resolve } from "node:path";
import * as Effect from "effect/Effect";
import { enterAgentEnv } from "../../env.ts";
import { buildDefinitionShape, prepareDefinition } from "../../harnesses/pi-durable/open.ts";
import { holdingInstance, openServing } from "../../harnesses/pi-durable/serve.ts";
import { resolveStateRoot } from "../../paths.ts";
import { nextRun } from "../../schedule/cron.ts";
import { fireScheduleNow, scheduleSessions } from "../../schedule/scheduler.ts";
import { latestFire, readFires } from "../../schedule/state.ts";
import { listWakeups, removeAnyWakeup } from "../../schedule/wakeups.ts";
import { failStartup, agentDirOrExit } from "../fail.ts";
import { exitCodeOf } from "../invoke-stream.ts";
import { enterAgentCommand, reportAuth } from "../shared.ts";

/**
 * Text mode answers "when does each run next, and did the last run work?" from the newest claim alone, so an old file
 * in the retained window cannot fail it; `--json` adds each schedule's whole retained fire history (the claims under
 * `schedule/claims/<name>/`). What a run SAID is in its session, once it has fired.
 */
export async function runSchedulesList(dirArg: string, json: boolean): Promise<void> {
  const target = agentDirOrExit(resolve(dirArg));
  enterAgentEnv(target); // FASTAGENT_STATE_DIR may live in .env — read the SAME state root the scheduler wrote
  const stateRoot = resolveStateRoot(target);
  // Its shape only: listing what will fire needs none of the values the code reads.
  const { schedules } = await prepareDefinition(target)
    .then((definition) => buildDefinitionShape(definition, process.env))
    .catch(failStartup);
  const sessions = scheduleSessions(stateRoot);
  const now = new Date();
  // A claim state this command cannot read is the operator's to fix: one line, never a Node stack.
  const read = <T>(name: string, what: string, fn: () => T): T => {
    try {
      return fn();
    } catch (e) {
      failStartup(new Error(`the ${what} of "${name}" is unreadable (state: ${stateRoot}): ${String(e)}`));
    }
  };
  const rows = schedules.map(({ name, cron, tz, prompt }) => ({
    name,
    cron,
    ...(tz === undefined ? {} : { tz }),
    ...(typeof prompt === "string" ? { prompt } : {}),
    next: nextRun(cron, tz, now)?.toISOString() ?? null,
    session: sessions.get(name) ?? null,
  }));
  const wakeups = listWakeups(stateRoot);
  if (json) {
    const withFires = rows.map((r) => ({
      ...r,
      fires: read(r.name, "fire history", () => readFires(stateRoot, r.name)),
    }));
    console.log(JSON.stringify({ schedules: withFires, wakeups }, null, 2));
    return;
  }
  if (rows.length === 0 && wakeups.length === 0) {
    console.error(`nothing scheduled — no src/schedules/, no wake-ups (agent: ${target})`);
    return;
  }
  for (const r of rows) {
    const last = read(r.name, "last fire", () => latestFire(stateRoot, r.name));
    const lastRun = last ? `last ${last.firedAt} ${last.outcome ?? "unreported"}` : "never run";
    console.log(
      `${r.name.padEnd(20)} next ${(r.next ?? "(never)").padEnd(26)}cron ${r.cron}${r.tz ? ` ${r.tz}` : ""}  ${lastRun}  session=${r.session ?? "(none yet)"}`,
    );
  }
  for (const w of wakeups) {
    const kind = w.cron ? `cron ${w.cron}${w.tz ? ` ${w.tz}` : ""}` : "one-shot";
    console.log(`wake ${w.id}  ${w.fireAt}  ${kind}  session=${w.session}  ${w.prompt.slice(0, 60)}`);
  }
}

/**
 * Fire the schedule `name` now, as its clock would: in its session, with its claim and its outcome recorded. It opens
 * the instance's storage, so a serve of it refuses this, and the other way round. The answer goes to stdout; exit 0
 * only when its message completed, as `invoke`'s.
 */
export async function runScheduleNow(
  name: string,
  dirArg: string,
  opts: { model?: string; input?: boolean },
): Promise<void> {
  const { agentDir, modelSpec } = await enterAgentCommand(dirArg, opts);
  // Refused while the instance holds work a stopped serve left: this process would run it, and cut it off at its exit.
  const { agent, models, schedules, stateRoot } = await openServing(agentDir, {
    model: modelSpec,
    unfinished: "refuse",
  }).catch(failStartup);
  const schedule = schedules.find((s) => s.name === name);
  if (schedule === undefined) {
    await agent.close();
    const declared = schedules.map((s) => s.name).join(", ") || "none";
    failStartup(new Error(`no schedule "${name}" in ${agentDir}/src/schedules/ (declared: ${declared})`));
  }
  await reportAuth(models, modelSpec, agentDir);
  const fired = await Effect.runPromise(fireScheduleNow({ agent, stateRoot, schedule })).catch(failStartup);
  const sessionId = scheduleSessions(stateRoot).get(name);
  const message =
    fired.fired && sessionId !== undefined
      ? await agent.getMessage(sessionId, { idempotencyKey: fired.slot.toISOString() })
      : undefined;
  const ended = message?.status === "done" ? message : undefined;
  if (ended?.answer !== undefined) process.stdout.write(`${ended.answer.text}\n`);
  await agent.close();
  if (!fired.fired) console.error(`[fastagent] ${name} did not fire: ${fired.skippedReason}`);
  // The claim counts a cut-off answer as completed; the exit code does not.
  else if (ended?.outcome.status === "max_tokens")
    console.error(`[fastagent] ${name}: its answer was cut off (max_tokens)`);
  process.exit(ended === undefined ? 1 : exitCodeOf(ended.outcome));
}

/**
 * Cancel the pending wake-up `id`, whatever session set it: the one way out of a wake-up set where nobody can message
 * the agent (a schedule's own session). It holds the instance's storage while it writes, so it is refused while a serve
 * of the instance runs, whose poll writes the same store.
 */
export async function runUnwake(id: string, dirArg: string): Promise<void> {
  const target = agentDirOrExit(resolve(dirArg));
  enterAgentEnv(target);
  const stateRoot = resolveStateRoot(target);
  const removed = await holdingInstance(stateRoot, () => removeAnyWakeup(stateRoot, id)).catch(failStartup);
  if (removed === undefined) {
    failStartup(new Error(`no pending wake-up ${id} (state: ${stateRoot}); \`fastagent schedules list\` shows them`));
  }
  console.log(
    `removed wake ${removed.id}  ${removed.fireAt}  session=${removed.session}  ${removed.prompt.slice(0, 60)}`,
  );
}
