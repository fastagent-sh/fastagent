/**
 * `fastagent fire <name> [dir]`: run ONE schedule's turn immediately — the authoring loop for schedules (like `invoke`
 * is for a prompt).
 */
import { join } from "node:path";
import { displayPath } from "../../paths.ts";
import { reportModuleLoadFailures } from "../../loader.ts";
import { createPiAgentFromDir } from "../../engines/pi/open.ts";
import { runInvokeStream } from "../invoke-stream.ts";
import { loadSchedules } from "../../schedule/discover.ts";
import { scheduleSession } from "../../schedule/scheduler.ts";
import { failStartup, gateSecretsOrExit } from "../fail.ts";
import { enterAgentCommand, reportAuth } from "../shared.ts";

export interface FireOptions {
  model?: string;
  authPath?: string;
  /** false ⇔ `--no-input`. */
  input?: boolean;
}

export async function runFire(name: string, dirArg: string, opts: FireOptions): Promise<void> {
  const placement = await enterAgentCommand(dirArg, opts);
  // Schedules are agent surface — discover them where dev/start/`schedule list` do (the agent dir), so `fire` sees
  // the same set the scheduler serves.
  const { schedules, secrets, failures } = await loadSchedules(placement.agentDir).catch(failStartup);
  // Reported BEFORE the name is looked up: a schedule file that failed to import is missing from
  // `schedules`, so "unknown schedule" is the case where the author most needs to hear about it.
  reportModuleLoadFailures(failures);
  const schedule = schedules.find((s) => s.name === name);
  if (!schedule) {
    // Name the discovery path: a schedule misplaced in the workspace (outside the agent dir) should read as "wrong
    // place", not "broken file".
    failStartup(
      new Error(
        `unknown schedule "${name}" (looked in ${displayPath(process.cwd(), join(placement.agentDir, "schedules")) ?? "schedules"}). ` +
          `available: ${schedules.map((s) => s.name).join(", ") || "(none)"}`,
      ),
    );
  }
  // `fire` RUNS this schedule, so it takes the serving path's guarantee: a prompt built from an
  // unset declared value is the degraded turn this feature exists to prevent (`Post the digest to `
  // — sent and executed), and the loader resolved it into a string before anything could notice.
  // THIS schedule only (`owner`): firing one job must not fail because a SIBLING SCHEDULE needs a
  // credential this machine has no reason to hold. The agent assembled below is a different question
  // and gates every mounted tool — a fired turn can call any of them — so `fire` is not free of a
  // tool's declaration, only of another schedule's. The failures go to the gate too, even though they
  // were printed above: its guarantee must not depend on this call site remembering (a repeated line
  // on the refusal path is the cheaper failure).
  gateSecretsOrExit({ declared: secrets, failures, owner: name });
  const { agent, modelSpec, authPath, fallbackAuthPath } = await createPiAgentFromDir(placement.workspace, {
    model: opts.model,
    authPath: opts.authPath, // flag > FASTAGENT_AUTH_PATH > default — resolved by the opener (one owner)
  }).catch(failStartup);
  console.error(`[fastagent] fire: ${name} (${modelSpec})`);
  await reportAuth(placement.agentDir, modelSpec, authPath, fallbackAuthPath);
  const exitCode = await runInvokeStream(
    agent.invoke({ session: scheduleSession(name) }, { text: schedule.prompt }),
    (text) => process.stdout.write(text),
    (line) => console.error(line),
  );
  process.stdout.write("\n");
  process.exit(exitCode);
}
