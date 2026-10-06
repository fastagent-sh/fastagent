/**
 * `fastagent schedules list` — what is going to wake this agent up: the schedules its definition declares, and the
 * wake-ups it set for itself.
 *
 * The two have different owners (a schedule is the definition's, a wake-up the state's, cancelled with `unwake`) but
 * answer the same operator question, so one command lists both, labelled apart.
 */
import { resolve } from "node:path";
import { enterAgentEnv } from "../../env.ts";
import { resolveStateRoot } from "../../paths.ts";
import { reportModuleLoadFailures } from "../../loader.ts";
import { nextRun } from "../../schedule/cron.ts";
import { loadSchedules } from "../../schedule/discover.ts";
import { scheduleSession } from "../../schedule/schedule.ts";
import { type Fire, readFires } from "../../schedule/state.ts";
import { listWakeups } from "../../schedule/wakeups.ts";
import { failStartup, agentDirOrExit } from "../fail.ts";

/**
 * Text mode answers "when does each run next, and did the last run work?"; `--json` adds each schedule's whole retained
 * fire history (the claims under `schedule/claims/<name>/`). What a run SAID is in its session, `schedule:<name>`.
 */
export async function runSchedulesList(dirArg: string, json: boolean): Promise<void> {
  const target = agentDirOrExit(resolve(dirArg));
  enterAgentEnv(target); // FASTAGENT_STATE_DIR may live in .env — read the SAME state root the scheduler wrote
  const stateRoot = resolveStateRoot(target);
  const { schedules, failures } = await loadSchedules(target).catch(failStartup);
  reportModuleLoadFailures(failures);
  const now = new Date();
  const rows = schedules.map((s) => {
    let fires: Fire[];
    try {
      fires = readFires(stateRoot, s.name);
    } catch (e) {
      failStartup(new Error(`the fire history of "${s.name}" is unreadable (state: ${stateRoot}): ${String(e)}`));
    }
    return { ...s, next: nextRun(s.cron, s.tz, now)?.toISOString() ?? null, session: scheduleSession(s.name), fires };
  });
  const wakeups = listWakeups(stateRoot);
  if (json) {
    console.log(JSON.stringify({ schedules: rows, wakeups }, null, 2));
    return;
  }
  if (rows.length === 0 && wakeups.length === 0) {
    console.error(`nothing scheduled — no schedules/*.md, no wake-ups (agent: ${target})`);
    return;
  }
  for (const r of rows) {
    const last = r.fires.at(-1);
    const lastRun = last ? `last ${last.firedAt} ${last.outcome ?? "unreported"}` : "never run";
    console.log(
      `${r.name.padEnd(20)} next ${(r.next ?? "(never)").padEnd(26)}cron ${r.cron}${r.tz ? ` ${r.tz}` : ""}  ${lastRun}  session=${r.session}`,
    );
  }
  for (const w of wakeups) {
    const kind = w.cron ? `cron ${w.cron}${w.tz ? ` ${w.tz}` : ""}` : "one-shot";
    console.log(`wake ${w.id}  ${w.fireAt}  ${kind}  session=${w.session}  ${w.prompt.slice(0, 60)}`);
  }
}
