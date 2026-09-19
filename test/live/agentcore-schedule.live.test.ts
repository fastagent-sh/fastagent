/**
 * A cron on a host with NO resident clock: EventBridge holds the timer, and the fire arrives as an
 * envelope the container has to accept.
 *
 * WHY THIS NEEDS A LIVE PROBE. Offline, the instant is ours — a fake clock, a literal ISO string in a
 * test fixture. Here it is AWS's, and two beliefs about it are load-bearing and untestable anywhere
 * else:
 *
 *   1. `POST /trigger` refuses any slot ahead of this machine's clock, with NO tolerance
 *      (schedule/trigger.ts). That refusal is what stops an anonymous caller from claiming a future
 *      slot and starving the schedule for good — but it also means a container whose clock lags the
 *      instant EventBridge computed would 400 every real fire. Whether that happens is a fact about
 *      two clocks we do not own, and the only way to learn it is to let them both run.
 *   2. `<aws.scheduler.scheduled-time>` lands on the same grid our own cron expression produces
 *      (`toEventBridgeCron` translates the pattern; `previousRun` reads it back). Nothing requires
 *      that today — the route deliberately does not validate the grid, precisely because this
 *      agreement was unverified. This probe records whether it holds, so a later decision to depend
 *      on it starts from a measurement rather than an assumption.
 *
 * WHAT IT OBSERVES, and from where. The forwarder logs one line per delivery —
 * `schedule-fire <name> (<slot>): <status> <body>` (deploy/agentcore/forwarder.js) — which carries
 * both facts above and is readable from outside the deployment. That is the whole point of reading
 * CloudWatch rather than the container: a 400 here would be invisible from inside an agent that
 * simply never ran.
 *
 * The cron is every-minute so the wait is bounded; EventBridge Scheduler's floor is one minute.
 *
 * WHAT IT MEASURED, ap-southeast-1, 2026-09-19 — recorded so the next reader does not have to deploy
 * to learn it:
 *
 *     schedule-fire tick (2026-09-19T13:04:00Z): 200 {"fired":true,"ms":2017}
 *     …logged at 13:04:09.372Z
 *
 * The instant is on the minute, i.e. on the grid `* * * * *` produces. And it reached the container
 * NINE SECONDS after it had passed — an order of magnitude more margin than any plausible NTP skew,
 * which is the number the no-tolerance rule in trigger.ts was an open question against.
 *
 * COSTS REAL RESOURCES (a full AgentCore stack with a forwarder, a Function URL and an EventBridge
 * rule) and one real model turn per minute it is up. Teardown is the shared
 * {@link destroyAgentcoreDeployment}.
 *
 * Needs the same IAM as `agentcore-deploy`, plus `logs:FilterLogEvents` on the forwarder group.
 */
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentcoreName, forwarderLogGroup } from "../../src/deploy/agentcore/plan.ts";
import { parseStackOutputs } from "../../src/deploy/agentcore/run.ts";
import { previousRun } from "../../src/schedule/cron.ts";
import { CLI, aws, destroyAgentcoreDeployment, liveVersion, requireAwsAccount, requireEnv, run } from "./env.ts";

const MODEL = requireEnv("FASTAGENT_LIVE_MODEL", 'the model under test, e.g. "anthropic/claude-sonnet-4-5"');

const NAME = agentcoreName(`live-probe-${randomUUID().slice(0, 8)}`);
const STACK = `fastagent-${NAME}`;
const SCHEDULE = "tick";
/** Every minute: EventBridge Scheduler's own floor, and what bounds this probe's wait. */
const CRON = "* * * * *";

let workspace = "";
let account = "";

beforeAll(async () => {
  account = await requireAwsAccount(45);
  if (process.env.RUNNER_TEMP) await appendFile(join(process.env.RUNNER_TEMP, "agentcore-probe-names"), `${NAME}\n`);

  workspace = join(tmpdir(), NAME);
  // Nested, because `deploy` requires a workspace that CONTAINS the agent (preflight.ts).
  const agentDir = join(workspace, "fastagent");
  await mkdir(join(agentDir, "schedules"), { recursive: true });
  await writeFile(join(agentDir, "persona.md"), "You are terse. Answer in as few words as possible.\n");
  await writeFile(join(agentDir, "fastagent.config.ts"), `export default { model: ${JSON.stringify(MODEL)} };\n`);
  // The ONE line that decides this deployment's topology: a schedule puts a forwarder, a Function URL
  // and an EventBridge rule into the template (plan.ts agentcoreTopology).
  // A plain default export, not `defineSchedule`: that helper is an identity function, so the loader
  // sees the same shape either way, and this fixture then needs no `npm install` before `deploy` reads
  // it. (The deployed image installs the package itself; this file is read on the BUILDER.)
  await writeFile(
    join(agentDir, "schedules", `${SCHEDULE}.ts`),
    `export default { cron: ${JSON.stringify(CRON)}, prompt: "Reply with just: tick" };\n`,
  );
  await writeFile(
    join(agentDir, "package.json"),
    `${JSON.stringify(
      {
        name: "live-agentcore-schedule-probe",
        private: true,
        dependencies: { "@fastagent-sh/fastagent": await liveVersion() },
      },
      null,
      2,
    )}\n`,
  );
});

afterAll(async () => {
  try {
    await destroyAgentcoreDeployment(NAME, account);
  } finally {
    if (workspace) await rm(workspace, { recursive: true, force: true });
  }
}, 900_000);

/** `schedule-fire <name> (<slot>): <status> <body>` — the forwarder's one line per delivery. */
const FIRE_LINE = new RegExp(`schedule-fire ${SCHEDULE} \\(([^)]+)\\): (\\d+)`);

/** Poll the forwarder's log group until it has said something about a fire, or the budget runs out. */
async function waitForFire(sinceMs: number, budgetMs: number): Promise<{ slot: string; status: number; raw: string }> {
  const group = forwarderLogGroup(NAME);
  const deadline = Date.now() + budgetMs;
  let lastError = "no forwarder log group yet";
  while (Date.now() < deadline) {
    const events = await aws([
      "logs",
      "filter-log-events",
      "--log-group-name",
      group,
      "--start-time",
      String(sinceMs),
      "--filter-pattern",
      `"schedule-fire ${SCHEDULE}"`,
      "--output",
      "json",
    ]);
    if (events.code === 0) {
      for (const event of (JSON.parse(events.stdout) as { events?: { message?: string }[] }).events ?? []) {
        const matched = FIRE_LINE.exec(event.message ?? "");
        if (matched)
          return { slot: matched[1] as string, status: Number(matched[2]), raw: (event.message ?? "").trim() };
      }
      lastError = "the forwarder log group exists but has logged no schedule-fire";
    } else {
      // Absent until first use: AWS creates the group when the Lambda first writes.
      lastError = events.stderr.trim().slice(0, 300);
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  throw new Error(`no schedule-fire delivery within ${Math.round(budgetMs / 1000)}s — ${lastError}`);
}

describe("agentcore schedules: EventBridge holds the clock and the container accepts its instant", () => {
  it("delivers a fire the trigger route ACCEPTS, on the grid our own expression produces", async () => {
    const deployedAt = Date.now();
    try {
      await run(process.execPath, [CLI, "deploy", "agentcore", "--run"], workspace);
    } catch (error) {
      const e = error as { stderr?: string; stdout?: string };
      throw new Error(`deploy agentcore --run failed for ${STACK}:\n${(e.stderr || e.stdout || "").slice(-4000)}`);
    }

    const outputs = await aws([
      "cloudformation",
      "describe-stacks",
      "--stack-name",
      STACK,
      "--query",
      "Stacks[0].Outputs",
      "--output",
      "json",
    ]);
    expect(outputs.code, `describe-stacks failed: ${outputs.stderr}`).toBe(0);
    const stackOutputs = parseStackOutputs(outputs.stdout);
    expect(
      stackOutputs.ForwarderUrl,
      `a schedule should have put a forwarder in the stack:\n${outputs.stdout.slice(0, 500)}`,
    ).toBeTruthy();

    // 6 minutes: the rule fires every minute, but the first invocation also cold-starts the container
    // and opens the definition, and CloudWatch is eventually consistent about the group itself.
    const fire = await waitForFire(deployedAt, 360_000);

    // (1) THE assertion this probe exists for. A 400 here is `POST /trigger` refusing the instant as
    // ahead of the container's clock — the zero-tolerance rule meeting a real clock pair. It would be
    // invisible from inside the agent, which would simply never run.
    expect(fire.status, `the forwarder's delivery was refused: ${fire.raw}`).toBe(200);

    // (2) Recorded, not depended on: whether AWS's instant is one our own expression would produce.
    // The route does not validate this today, and this is the measurement a later decision would need.
    const slot = new Date(fire.slot);
    expect(Number.isNaN(slot.getTime()), `unparseable slot in: ${fire.raw}`).toBe(false);
    expect(
      previousRun(CRON, undefined, slot)?.toISOString(),
      `EventBridge's scheduled-time is NOT on the grid "${CRON}" produces — a future decision to ` +
        `validate the grid in POST /trigger would reject every real fire on this host (${fire.raw})`,
    ).toBe(slot.toISOString());
  }, 1_800_000);
});
