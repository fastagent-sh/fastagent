/**
 * `fastagent routine history|list` — the routines this DEFINITION declares.
 *
 * The agent's own pending wake-ups are not here and have no command: they live in the state, not the definition,
 * and `unwake({ id })` is what cancels one (schedule/wakeups.ts says why).
 */
import { resolve } from "node:path";
import { enterAgentEnv } from "../../env.ts";
import { resolveSessionsDir, resolveStateRoot } from "../../paths.ts";
import { reportModuleLoadFailures } from "../../loader.ts";
import { nextRun } from "../../schedule/cron.ts";
import { loadRoutines } from "../../schedule/discover.ts";
import { routineSession } from "../../schedule/routine.ts";
import { type Fire, isSafeScheduleName, readFires } from "../../schedule/state.ts";
import { failStartup, placementOrExit } from "../fail.ts";

/**
 * `fastagent routine history <name> [dir]`: print this routine's fired slots — when each fired, how it ended, how
 * long it took.
 *
 * The history IS the claims (`schedule/claims/<name>/`), so it is bounded by construction and carries no turn text:
 * what the run SAID is in its session (`routine:<name>`), stored once, like any other turn's, under the state
 * root's `sessions/` — which is where this command points rather than copying any of it here.
 *
 * This command does NOT try to say which turn belongs to which fire. Nothing links them: a routine's fires share
 * ONE continuing conversation, so the session id is the same for all of them, and the turn-level identifier would
 * have to cross the engine-neutral contract (no `AgentEvent` carries an entry id) or cost the shared conversation.
 * A claim's timestamp against a time-ordered journal is what an operator reads anyway — matching them HERE only
 * moves a human's judgement into a heuristic that cannot be right about a session other writers also append to.
 */
export function runRoutineHistory(name: string, dirArg: string, json: boolean): void {
  const { agentDir: target } = placementOrExit(resolve(dirArg));
  enterAgentEnv(target); // FASTAGENT_STATE_DIR may live in .env — read the SAME state root the scheduler wrote
  const stateRoot = resolveStateRoot(target);
  // A name that cannot be a routine is a MISTYPED ARGUMENT, and it must not look like an empty history: exit 1 the
  // way every other user-input refusal does, so `--json` printing nothing is never read as "the command succeeded".
  if (!isSafeScheduleName(name)) {
    failStartup(new Error(`"${name}" cannot be a routine name (no path separators, "." or "..")`));
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
  // The other half of the answer, and where it lives: these rows say a fire happened, not what it produced. The
  // session id comes from the ONE place that spells it and the directory from the ONE place that resolves it. The
  // record is one level further down and under a name pi accepts (`piSessionId` escapes the `:`), so the pointer
  // says how to recognise the file rather than claiming a path the reader can paste.
  console.error(
    `(what these runs said: session ${routineSession(name)} — a JSON-lines journal under ${resolveSessionsDir(target)}, ` +
      `in the file whose name carries "${name}")`,
  );
}

/** `fastagent routine list [dir]`: every declared unit of work, and when (or whether) a clock fires it. */
export async function runRoutineList(dirArg: string, json: boolean): Promise<void> {
  const { agentDir: target } = placementOrExit(resolve(dirArg));
  enterAgentEnv(target);
  const { routines, failures } = await loadRoutines(target).catch(failStartup);
  reportModuleLoadFailures(failures);
  if (json) {
    console.log(
      JSON.stringify(
        {
          routines: routines.map((r) => ({
            ...r,
            next: r.cron === undefined ? null : (nextRun(r.cron, r.tz, new Date())?.toISOString() ?? null),
          })),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (routines.length === 0) {
    console.error(`no routines declared — nothing in routines/ (agent: ${target})`);
    return;
  }
  for (const r of routines) {
    // A routine with no cron is not broken and not idle: it is reached by NAME (`routine run`, `POST /run`), and
    // saying "on demand" is the difference between that and a cron that will never fire again.
    const when =
      r.cron === undefined
        ? "on demand".padEnd(26)
        : `${(nextRun(r.cron, r.tz, new Date())?.toISOString() ?? "(never)").padEnd(26)}cron ${r.cron}${r.tz ? ` ${r.tz}` : ""}`;
    console.log(`${r.name.padEnd(20)} ${when}`);
  }
}
