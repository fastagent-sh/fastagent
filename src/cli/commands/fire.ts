/**
 * `fastagent fire <name> [dir]`: run ONE schedule's turn immediately — the authoring loop for schedules
 * (like `invoke` is for a prompt). Fires `schedules/<name>.ts` now, without waiting for its cron, using
 * the schedule's stable session (faithful to the served behavior). Does NOT advance the schedule's fire
 * state — a test run must never make the scheduler skip the real next run.
 */
import { join, resolve } from "node:path";
import { loadDotEnv } from "../../env.ts";
import { displayPath } from "../../paths.ts";
import { reportModuleLoadFailures } from "../../log.ts";
import { createPiAgentFromDir } from "../../engines/pi/open.ts";
import { runInvokeStream } from "../invoke-stream.ts";
import { installProxyFetch } from "../../proxy.ts";
import { loadSchedules } from "../../schedule/discover.ts";
import { scheduleSession } from "../../schedule/scheduler.ts";
import { failStartup, placementOrExit } from "../fail.ts";
import { reportAuth, resolveFirstRunModel } from "../shared.ts";

export interface FireOptions {
  model?: string;
  authPath?: string;
  /** false ⇔ `--no-input`. */
  input?: boolean;
}

export async function runFire(name: string, dirArg: string, opts: FireOptions): Promise<void> {
  const fireDir = resolve(dirArg);
  const placement = placementOrExit(fireDir);
  loadDotEnv(placement.agentDir);
  installProxyFetch();
  await resolveFirstRunModel(placement.agentDir, opts);
  // Schedules are agent surface — discover them where dev/start/`schedule list` do (the agent
  // dir), so `fire` sees the same set the scheduler serves.
  const { schedules, failures } = await loadSchedules(placement.agentDir).catch(failStartup);
  reportModuleLoadFailures(failures);
  const schedule = schedules.find((s) => s.name === name);
  if (!schedule) {
    // Name the discovery path: a schedule misplaced in the workspace (outside the agent dir)
    // should read as "wrong place", not "broken file".
    failStartup(
      new Error(
        `unknown schedule "${name}" (looked in ${displayPath(process.cwd(), join(placement.agentDir, "schedules")) ?? "schedules"}). ` +
          `available: ${schedules.map((s) => s.name).join(", ") || "(none)"}`,
      ),
    );
  }
  const { agent, modelSpec, authPath } = await createPiAgentFromDir(fireDir, {
    model: opts.model,
    authPath: opts.authPath, // flag > FASTAGENT_AUTH_PATH > default — resolved by the opener (one owner)
  }).catch(failStartup);
  console.error(`[fastagent] fire: ${name} (${modelSpec})`);
  await reportAuth(placement.agentDir, modelSpec, authPath);
  const exitCode = await runInvokeStream(
    agent.invoke({ session: scheduleSession(name) }, { text: schedule.prompt }),
    (text) => process.stdout.write(text),
    (line) => console.error(line),
  );
  process.stdout.write("\n");
  process.exit(exitCode);
}
