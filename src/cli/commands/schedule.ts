/**
 * `fastagent schedule history|list|cancel` — the operator's surface over schedule state. history and
 * list are read-only; cancel is the kill switch for a pending wake-up (the agent's own is the `unwake`
 * tool). All three read the SAME state root the scheduler writes (FASTAGENT_STATE_DIR may live in .env).
 */
import { resolve } from "node:path";
import { loadDotEnv } from "../../env.ts";
import { loadConfig, resolveAgentDir, resolveStateRoot } from "../../engines/pi/config.ts";
import { reportModuleLoadFailures } from "../../engines/pi/report.ts";
import { readRuns } from "../../schedule/audit.ts";
import { nextRun } from "../../schedule/cron.ts";
import { loadSchedules } from "../../schedule/discover.ts";
import { listWakeups, removeWakeup } from "../../schedule/wakeups.ts";
import { failStartup } from "../fail.ts";

/**
 * `fastagent schedule history <name> [dir]`: print the run audit for one schedule (or "wake") — fired
 * time, outcome, duration, reply/error. Read-only (reads `<stateRoot>/schedule/runs.jsonl`); the answer
 * to "did last night's run silently fail?". Text mode previews the reply/error; --json is the full record.
 */
export function runScheduleHistory(name: string, dirArg: string, json: boolean): void {
  const target = resolve(dirArg);
  loadDotEnv(target); // FASTAGENT_STATE_DIR may live in .env — read the SAME state root the scheduler wrote
  const runs = readRuns(resolveStateRoot(target), name);
  if (json) {
    console.log(JSON.stringify(runs, null, 2));
    return;
  }
  if (runs.length === 0) {
    console.error(`no recorded runs for "${name}" (state: ${resolveStateRoot(target)})`);
    return;
  }
  // The question is "did LAST NIGHT's run fail?" — so text mode tails the most recent runs (chronological
  // within the tail); --json above returns the full history.
  const TAIL = 20;
  const shown = runs.slice(-TAIL);
  if (runs.length > shown.length) {
    console.error(`(showing the last ${shown.length} of ${runs.length} runs — --json for all)`);
  }
  for (const r of shown) {
    const detail = r.error ?? r.reply ?? "";
    const preview = detail.replace(/\s+/g, " ").slice(0, 100);
    console.log(`${r.firedAt}  ${r.outcome.padEnd(9)} ${String(r.ms).padStart(6)}ms  ${preview}`);
  }
}

/** `fastagent schedule list [dir]`: everything that will fire — BOTH producers: the static `schedules/`
 *  files (with their next instant) and the agent's pending self-scheduled wake-ups. Read-only. */
export async function runScheduleList(dirArg: string, json: boolean): Promise<void> {
  const target = resolve(dirArg);
  loadDotEnv(target);
  const { config } = await loadConfig(target).catch(failStartup);
  const agentDir = resolveAgentDir(target, config);
  const { schedules, failures } = await loadSchedules(agentDir).catch(failStartup);
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

/** `fastagent schedule cancel <id> [dir]`: remove a pending wake-up — the operator's kill switch (the
 *  agent's own is the `unwake` tool). Unlike unwake it is NOT session-scoped: the operator owns the box. */
export function runScheduleCancel(id: string, dirArg: string): void {
  const target = resolve(dirArg);
  loadDotEnv(target);
  if (removeWakeup(resolveStateRoot(target), id)) {
    // ponytail: the store's load→save is lock-free — a serving scheduler's claim-advance can race this
    // write (window = ms around each fire). Tell the operator to verify; a lockfile/CAS is the upgrade
    // path if it ever bites.
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
