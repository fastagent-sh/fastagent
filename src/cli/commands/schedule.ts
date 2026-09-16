/** `fastagent schedule history|list|cancel`. */
import { resolve } from "node:path";
import { enterAgentEnv } from "../../env.ts";
import { resolveStateRoot } from "../../paths.ts";
import { reportModuleLoadFailures } from "../../loader.ts";
import { nextRun } from "../../schedule/cron.ts";
import { loadSchedules } from "../../schedule/discover.ts";
import { type Fire, isSafeScheduleName, readFires } from "../../schedule/state.ts";
import { listWakeups, removeWakeup } from "../../schedule/wakeups.ts";
import { failStartup, placementOrExit } from "../fail.ts";

/**
 * `fastagent schedule history <name> [dir]`: print this schedule's fired slots — when each fired, how it ended, how
 * long it took.
 *
 * The history IS the claims (`schedule/claims/<name>/`), so it is bounded by construction and carries no turn text:
 * what the run SAID is in its session (`schedule:<name>`), stored once, like any other turn's.
 */
export function runScheduleHistory(name: string, dirArg: string, json: boolean): void {
  const { agentDir: target } = placementOrExit(resolve(dirArg));
  enterAgentEnv(target); // FASTAGENT_STATE_DIR may live in .env — read the SAME state root the scheduler wrote
  const stateRoot = resolveStateRoot(target);
  // A name that cannot be a schedule is a MISTYPED ARGUMENT, and it must not look like an empty history: exit 1 the
  // way every other user-input refusal does, so `--json` printing nothing is never read as "the command succeeded".
  if (!isSafeScheduleName(name)) {
    failStartup(new Error(`"${name}" cannot be a schedule name (no path separators, "." or "..")`));
  }
  // `readFires` throws a raw fs error on unreadable state, because its other caller is the serving boot, which must
  // fail rather than arm a schedule it cannot read. This caller is a read-only CLI command: the same fact is an
  // operator's to fix, so it exits the way every other refusal in this file does instead of printing a Node stack.
  let fires: Fire[];
  try {
    fires = readFires(stateRoot, name);
  } catch (e) {
    failStartup(new Error(`the fired-slot claims for "${name}" are unreadable (state: ${stateRoot}): ${String(e)}`));
  }
  if (json) {
    console.log(JSON.stringify(fires, null, 2));
    return;
  }
  if (fires.length === 0) {
    // No special case for "wake": it is an ordinary schedule name now (`discover.ts` stopped reserving it).
    console.error(`no recorded fires for "${name}" (state: ${stateRoot})`);
    return;
  }
  // The question is "did LAST NIGHT's run fail?", so text mode tails the most recent fires; --json above is the
  // whole retained window.
  const TAIL = 20;
  const shown = fires.slice(-TAIL);
  for (const f of shown) {
    // An unreported fire has no duration to print, and `0ms` would be a value a fast turn really produces — the
    // column stays empty rather than claiming the turn took no time.
    const took = f.ms === undefined ? "" : `${f.ms}ms`;
    console.log(`${f.firedAt}  ${(f.outcome ?? "unreported").padEnd(11)} ${took.padStart(8)}`);
  }
  if (fires.length > shown.length) {
    console.error(`(the last ${shown.length} of ${fires.length} fires — --json for all)`);
  }
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
