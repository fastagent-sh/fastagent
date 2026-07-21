/**
 * `fastagent fire <name> [dir]`: run ONE schedule's turn immediately — the authoring loop for schedules
 * (like `invoke` is for a prompt). Fires `schedules/<name>.ts` now, without waiting for its cron, using
 * the schedule's stable session (faithful to the served behavior). Does NOT advance the schedule's fire
 * state — a test run must never make the scheduler skip the real next run.
 */
import { relative, resolve, sep } from "node:path";
import { loadDotEnv } from "../../env.ts";
import { loadConfig, resolveAgentDir } from "../../engines/pi/config.ts";
import { reportModuleLoadFailures } from "../../engines/pi/report.ts";
import { createPiAgentFromWorkspace } from "../../engines/pi/workspace.ts";
import { runInvokeStream } from "../invoke-stream.ts";
import { installProxyFetch } from "../../proxy.ts";
import { loadSchedules } from "../../schedule/discover.ts";
import { scheduleSession } from "../../schedule/scheduler.ts";
import { failStartup } from "../fail.ts";
import { reportAuth, resolveFirstRunModel } from "../shared.ts";

export interface FireOptions {
  model?: string;
  authPath?: string;
  /** false ⇔ `--no-input`. */
  input?: boolean;
}

export async function runFire(name: string, dirArg: string, opts: FireOptions): Promise<void> {
  const fireDir = resolve(dirArg);
  loadDotEnv(fireDir);
  installProxyFetch();
  await resolveFirstRunModel(fireDir, opts);
  // Schedules are agent surface — discover them where dev/start/`schedule list` do (agentDir), not the
  // run root, so `fire` sees the same set the scheduler serves in the kit layout.
  const { config: fireConfig } = await loadConfig(fireDir).catch(failStartup);
  const fireAgentDir = resolveAgentDir(fireDir, fireConfig);
  const { schedules, failures } = await loadSchedules(fireAgentDir).catch(failStartup);
  reportModuleLoadFailures(failures);
  const schedule = schedules.find((s) => s.name === name);
  if (!schedule) {
    // Name the discovery path in the kit layout: a schedule misplaced at the run root should read as
    // "wrong place", not "broken file".
    const looked =
      fireAgentDir === fireDir ? "" : ` (looked in ${relative(fireDir, fireAgentDir).split(sep).join("/")}/schedules)`;
    failStartup(
      new Error(
        `unknown schedule "${name}"${looked}. available: ${schedules.map((s) => s.name).join(", ") || "(none)"}`,
      ),
    );
  }
  const { agent, modelSpec, authPath } = await createPiAgentFromWorkspace(fireDir, {
    model: opts.model,
    authPath: opts.authPath, // flag > FASTAGENT_AUTH_PATH > default — resolved by the opener (one owner)
  }).catch(failStartup);
  console.error(`[fastagent] fire: ${name} (${modelSpec})`);
  await reportAuth(modelSpec, authPath);
  const exitCode = await runInvokeStream(
    agent.invoke({ session: scheduleSession(name) }, { text: schedule.prompt }),
    (text) => process.stdout.write(text),
    (line) => console.error(line),
  );
  process.stdout.write("\n");
  process.exit(exitCode);
}
