/** `fastagent schedule history|list|cancel`. */
import { resolve } from "node:path";
import { enterAgentEnv } from "../../env.ts";
import { resolveStateRoot } from "../../paths.ts";
import { reportModuleLoadFailures } from "../../loader.ts";
import { nextRun } from "../../schedule/cron.ts";
import { loadSchedules } from "../../schedule/discover.ts";
import { isSafeScheduleName, readFires } from "../../schedule/state.ts";
import { listWakeups, removeWakeup } from "../../schedule/wakeups.ts";
import { failStartup, placementOrExit } from "../fail.ts";

/**
 * `fastagent schedule history <name> [dir]`: print this schedule's fired slots — when each fired, how it ended, how
 * long it took.
 *
 * The history IS the claims (`schedule/claims/<name>/`), so it is bounded by construction and carries no turn text:
 * what the run SAID is a log line, and the logs are where a deployment already rotates them.
 */
export function runScheduleHistory(name: string, dirArg: string, json: boolean): void {
  const { agentDir: target } = placementOrExit(resolve(dirArg));
  enterAgentEnv(target); // FASTAGENT_STATE_DIR may live in .env — read the SAME state root the scheduler wrote
  const stateRoot = resolveStateRoot(target);
  if (!isSafeScheduleName(name)) {
    console.error(`"${name}" is not a schedule name`);
    return;
  }
  const fires = readFires(stateRoot, name);
  if (json) {
    console.log(JSON.stringify(fires, null, 2));
    return;
  }
  if (fires.length === 0) {
    console.error(`no recorded fires for "${name}" (state: ${stateRoot})`);
    // The agent's own wake-ups have no claim to record: they are removed from the store before the turn starts.
    if (name === "wake") console.error("self-scheduled wake-ups are not recorded here — see the service logs");
    return;
  }
  for (const f of fires) {
    const outcome = f.outcome ?? "unreported";
    console.log(`${f.firedAt}  ${outcome.padEnd(11)} ${String(f.ms ?? 0).padStart(6)}ms`);
  }
  console.error(`(the last ${fires.length} fires — what each run said is in the service logs)`);
}

/** `fastagent schedule list [dir]`: everything that will fire. */
export async function runScheduleList(dirArg: string, json: boolean): Promise<void> {
  const { agentDir: target } = placementOrExit(resolve(dirArg));
  enterAgentEnv(target);
  const { schedules, failures } = await loadSchedules(target).catch(failStartup);
  reportModuleLoadFailures(failures);
  const wakeups = listWakeups(resolveStateRoot(target));
  if (json) {
    console.log(
      JSON.stringify(
        {
          schedules: schedules.map((s) => ({ ...s, next: nextRun(s.cron, s.tz, new Date())?.toISOString() })),
          wakeups,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (schedules.length === 0 && wakeups.length === 0) {
    console.error(`nothing scheduled — no schedules/ files, no pending wake-ups (state: ${resolveStateRoot(target)})`);
    return;
  }
  for (const s of schedules) {
    const next = nextRun(s.cron, s.tz, new Date())?.toISOString() ?? "(never)";
    console.log(`schedule  ${s.name.padEnd(20)} ${next}  cron ${s.cron}${s.tz ? ` ${s.tz}` : ""}`);
  }
  for (const w of wakeups) {
    const kind = w.cron ? `cron ${w.cron}${w.tz ? ` ${w.tz}` : ""}` : "one-shot";
    console.log(`wake      ${w.id}  ${w.fireAt}  ${kind}  session=${w.session}  ${w.prompt.slice(0, 60)}`);
  }
}

/**
 * `fastagent schedule cancel <id> [dir]`: remove a pending wake-up — the operator's kill switch (the agent's own is
 * the `unwake` tool).
 */
export function runScheduleCancel(id: string, dirArg: string): void {
  const { agentDir: target } = placementOrExit(resolve(dirArg));
  enterAgentEnv(target);
  if (removeWakeup(resolveStateRoot(target), id)) {
    // ponytail: the store's load→save is lock-free — a serving scheduler's claim-advance can race this write (window
    // = ms around each fire).
    console.error(
      `[fastagent] cancelled wake-up ${id} — if a server is running, verify with \`fastagent schedule list\``,
    );
  } else {
    failStartup(
      new Error(
        `no pending wake-up ${id} (state: ${resolveStateRoot(target)}) — \`fastagent schedule list\` shows ids`,
      ),
    );
  }
}
