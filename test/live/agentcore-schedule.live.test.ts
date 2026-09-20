/**
 * A cron on a host with NO resident clock: EventBridge holds the timer, and the fire arrives as an
 * envelope the container has to accept.
 *
 * WHY THIS NEEDS A LIVE PROBE. Offline, everything about this delivery is ours — a fake clock, a
 * faked EventBridge, a handler called directly. Here the timer, the forwarder and the container's
 * clock are all AWS's, and two beliefs about them are load-bearing and untestable anywhere else:
 *
 *   1. The envelope names a schedule and NOTHING ELSE, so the container decides which occurrence the
 *      delivery is for by snapping its OWN clock to the grid (schedule/trigger.ts). That is only
 *      correct if the delivery lands inside the occurrence it was scheduled for — late enough to be
 *      past the instant, early enough not to have fallen into the next one. Whether that holds is a
 *      fact about a clock and a delivery path we do not own.
 *   2. The container accepts the delivery at all: a cold start, an opened definition and a model turn
 *      all happen inside the forwarder's call, and a non-200 here would be invisible from inside an
 *      agent that simply never ran.
 *
 * WHAT IT OBSERVES, and from where. The forwarder logs one line per delivery —
 * `schedule-fire <name>: <status> <body>` (deploy/agentcore/forwarder.js) — and the body carries the
 * slot the CONTAINER chose. That is the whole point of reading CloudWatch rather than the container.
 *
 * The cron is every-minute so the wait is bounded; EventBridge Scheduler's floor is one minute. It is
 * also the tightest possible version of belief (1): with a 60-second occurrence, a delivery more than
 * a minute late would visibly land on the wrong grid point. Anything coarser would hide that.
 *
 * WHAT IT MEASURED, ap-southeast-1, 2026-09-19 — recorded so the next reader does not have to deploy
 * to learn it. (Measured against the earlier wire, which carried the instant; the numbers are facts
 * about the delivery path, not about the envelope.)
 *
 *     schedule-fire tick (2026-09-19T13:04:00Z): 200 {"fired":true,"ms":2017}
 *     …logged at 13:04:09.372Z
 *
 * NINE SECONDS after the instant it was scheduled for, and 51 seconds before the next one — the
 * margin belief (1) needs, on both sides.
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

/** `schedule-fire <name>: <status> <body>` — the forwarder's one line per delivery. */
const FIRE_LINE = new RegExp(`schedule-fire ${SCHEDULE}: (\\d+) (.*)$`);

/** Poll the forwarder's log group until it has said something about a fire, or the budget runs out. */
async function waitForFire(sinceMs: number, budgetMs: number): Promise<{ body: string; status: number; raw: string }> {
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
          return { status: Number(matched[1]), body: matched[2] as string, raw: (event.message ?? "").trim() };
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

describe("agentcore schedules: EventBridge holds the clock, the container names the occurrence", () => {
  it("delivers a fire the container accepts, and lands inside the occurrence it was scheduled for", async () => {
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

    // (1) The container ACCEPTED it. A non-200 is a cold start, an opened definition or a model turn
    // failing inside the forwarder's call — invisible from inside an agent that would simply never run.
    expect(fire.status, `the forwarder's delivery was refused: ${fire.raw}`).toBe(200);

    // (2) THE assertion this probe exists for. The envelope carries no instant, so the slot in the
    // reply is the container's own clock snapped to this schedule's grid. It has to be a grid point,
    // and it has to be the one the rule fired for — which, for a one-minute cron, means the delivery
    // landed inside its own 60-second occurrence. Late by more than that and this reads the NEXT
    // point; early (a container clock ahead of AWS's) and it reads the previous one.
    const reply = JSON.parse(fire.body) as { slot?: string; fired?: boolean };
    expect(reply.slot, `no slot in the container's reply: ${fire.raw}`).toBeTruthy();
    const slot = new Date(reply.slot as string);
    expect(Number.isNaN(slot.getTime()), `unparseable slot in: ${fire.raw}`).toBe(false);
    expect(
      previousRun(CRON, undefined, slot)?.toISOString(),
      `the container's chosen slot is not on the grid "${CRON}" produces (${fire.raw})`,
    ).toBe(slot.toISOString());
    // Within one occurrence of when this probe started waiting — the delivery is not hours stale.
    expect(
      Math.abs(slot.getTime() - deployedAt) < 6 * 60_000 + 60_000,
      `the chosen slot ${slot.toISOString()} is not near this probe's deploy (${fire.raw})`,
    ).toBe(true);
  }, 1_800_000);
});
