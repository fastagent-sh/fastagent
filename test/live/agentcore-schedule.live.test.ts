/**
 * A cron on a host with NO resident clock: EventBridge holds the timer, and the fire arrives as an
 * envelope the container has to accept.
 *
 * WHY THIS NEEDS A LIVE PROBE. Offline, everything about this delivery is ours — a fake clock, a
 * faked EventBridge, a handler called directly. Here the timer, the forwarder and the container are
 * all AWS's, and one belief about them is load-bearing and untestable anywhere else:
 *
 *   The container accepts the delivery at all, END TO END. A cold start, an opened definition, a
 *   model turn and the forwarder's own timeout all happen inside one invocation, and a non-200 would
 *   be invisible from inside an agent that simply never ran.
 *
 * WHAT IT NO LONGER HAS TO PROVE, and why. The design's other load-bearing fact — that EventBridge
 * repeats `<aws.scheduler.scheduled-time>` byte-identically across a redelivery, which is what lets
 * the container tell a retry from a new occurrence — was measured directly by a standalone spike
 * (EventBridge Scheduler → a Lambda that failed on purpose): 17 deliveries over 7 occurrences, up to 3
 * per occurrence, every redelivery carrying an identical payload, backoff at +60s and +186s. That is a
 * property of the SERVICE, not of this deployment, so it does not belong in a probe that also builds
 * a container. The numbers are recorded in schedule/trigger.ts, where the design reads them.
 *
 * WHAT IT OBSERVES, and from where. The forwarder logs one line per delivery —
 * `schedule-fire <name> (<occurrence>): <status> <body>` (deploy/agentcore/forwarder.js). That is the
 * whole point of reading CloudWatch rather than the container.
 *
 * The cron is every-minute so the wait is bounded; EventBridge Scheduler's floor is one minute.
 *
 * WHAT IT MEASURED, ap-southeast-1, 2026-09-19 — recorded so the next reader does not have to deploy
 * to learn it:
 *
 *     schedule-fire tick (2026-09-19T13:04:00Z): 200 {"fired":true,"ms":2017}
 *     …logged at 13:04:09.372Z
 *
 * NINE SECONDS from the scheduled instant to a completed turn, cold start included.
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
import { CLI, aws, destroyAgentcoreDeployment, installSpec, requireAwsAccount, requireEnv, run } from "./env.ts";

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
        dependencies: { "@fastagent-sh/fastagent": await installSpec(agentDir) },
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

/** `schedule-fire <name> (<occurrence>): <status> <body>` — the forwarder's one line per delivery. */
const FIRE_LINE = new RegExp(`schedule-fire ${SCHEDULE} \\(([^)]+)\\): (\\d+) (.*)$`);

/** Poll the forwarder's log group until it has said something about a fire, or the budget runs out. */
async function waitForFire(
  sinceMs: number,
  budgetMs: number,
): Promise<{ occurrence: string; body: string; status: number; raw: string }> {
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
          return {
            occurrence: matched[1] as string,
            status: Number(matched[2]),
            body: matched[3] as string,
            raw: (event.message ?? "").trim(),
          };
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

describe("agentcore schedules: EventBridge holds the clock and names each fire", () => {
  it("delivers a fire the container accepts, and runs the occurrence the clock named", async () => {
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

    // (1) THE assertion this probe exists for. A non-200 is a cold start, an opened definition, a model
    // turn or the forwarder's timeout failing — invisible from inside an agent that would never run.
    expect(fire.status, `the forwarder's delivery was refused: ${fire.raw}`).toBe(200);

    // (2) The occurrence the container ran is the one the CLOCK named — it does not recompute it, and
    // the reply is what the forwarder (and an operator) reads back.
    const reply = JSON.parse(fire.body) as { slot?: string; fired?: boolean };
    expect(reply.fired, `the delivery was accepted but nothing ran: ${fire.raw}`).toBe(true);
    expect(new Date(reply.slot as string).toISOString(), `container ran a different occurrence: ${fire.raw}`).toBe(
      new Date(fire.occurrence).toISOString(),
    );
  }, 1_800_000);
});
