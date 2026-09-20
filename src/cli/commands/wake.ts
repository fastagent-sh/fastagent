/**
 * `fastagent wake list|cancel` — the wake-ups an agent scheduled for ITSELF.
 *
 * SEPARATE FROM `routine` because the owner is different, and every operational difference follows from that: a
 * routine is written in the definition (versioned, named by its author, reachable by name), a wake-up is written
 * into the state by a running agent (minted id, aimed back at the conversation it came from, cancellable). Code and
 * data. They used to share one `schedule` command, which asked an operator to hold both at once.
 */
import { resolve } from "node:path";
import { enterAgentEnv } from "../../env.ts";
import { resolveStateRoot } from "../../paths.ts";
import { listWakeups, removeWakeup } from "../../schedule/wakeups.ts";
import { failStartup, placementOrExit } from "../fail.ts";

/** `fastagent wake list [dir]`: every pending wake-up, with the session it will resume. */
export function runWakeList(dirArg: string, json: boolean): void {
  const { agentDir: target } = placementOrExit(resolve(dirArg));
  enterAgentEnv(target);
  const stateRoot = resolveStateRoot(target);
  const wakeups = listWakeups(stateRoot);
  if (json) {
    console.log(JSON.stringify({ wakeups }, null, 2));
    return;
  }
  if (wakeups.length === 0) {
    console.error(`no pending wake-ups (state: ${stateRoot})`);
    return;
  }
  for (const w of wakeups) {
    const kind = w.cron ? `cron ${w.cron}${w.tz ? ` ${w.tz}` : ""}` : "one-shot";
    console.log(`${w.id}  ${w.fireAt}  ${kind}  session=${w.session}  ${w.prompt.slice(0, 60)}`);
  }
}

/**
 * `fastagent wake cancel <id> [dir]`: remove a pending wake-up — the operator's kill switch (the agent's own is
 * the `unwake` tool).
 */
export function runWakeCancel(id: string, dirArg: string): void {
  const { agentDir: target } = placementOrExit(resolve(dirArg));
  enterAgentEnv(target);
  if (removeWakeup(resolveStateRoot(target), id)) {
    // ponytail: the store's load→save is lock-free — a serving scheduler's claim-advance can race this write (window
    // = ms around each fire).
    console.error(
      `[fastagent] cancelled wake-up ${id} — if a server is running, verify with \`fastagent routine list\``,
    );
  } else {
    failStartup(
      new Error(`no pending wake-up ${id} (state: ${resolveStateRoot(target)}) — \`fastagent routine list\` shows ids`),
    );
  }
}
