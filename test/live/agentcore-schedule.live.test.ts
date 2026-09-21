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
 * a container. The numbers are recorded in schedule/run.ts, where the design reads them.
 *
 * WHAT IT OBSERVES, and from where. The forwarder logs one line per delivery —
 * `routine-fire <name> (<occurrence>): <status> <body>` (deploy/agentcore/forwarder.js). That is the
 * whole point of reading CloudWatch rather than the container.
 *
 * The cron is every-minute so the wait is bounded; EventBridge Scheduler's floor is one minute.
 *
 * WHAT IT MEASURED, ap-southeast-1, 2026-09-21 — recorded so the next reader does not have to deploy
 * to learn it. Seven consecutive deliveries of a `* * * * *` routine, read from the forwarder's log:
 *
 *     occurrence (clock)     container slot             status     lag     turn
 *     2026-09-21T07:39:00Z   2026-09-21T07:39:00.000Z   200      49.9s   3224ms   fired=true
 *     2026-09-21T07:40:00Z   2026-09-21T07:40:00.000Z   200      43.6s   2431ms   fired=true
 *     …five more, all 200, all `fired: true`, every slot identical to the occurrence EventBridge named
 *
 * The first is the cold one: container start, definition open and a model turn inside one invocation.
 * Steady state is 43.6–45.0s from the scheduled instant to a completed turn, of which ~2.4–3.8s is the
 * turn — i.e. the delivery lands some 40s after the instant, never before it, which is what
 * `POST /run`'s callers never have to think about and what a claim-keeping clock does.
 *
 * Every `slot` in the reply equals the `<aws.scheduler.scheduled-time>` the rule sent, which is the
 * design's whole claim: the clock names the occurrence and the container does not recompute it.
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
  await mkdir(join(agentDir, "routines"), { recursive: true });
  await writeFile(join(agentDir, "persona.md"), "You are terse. Answer in as few words as possible.\n");
  await writeFile(join(agentDir, "fastagent.config.ts"), `export default { model: ${JSON.stringify(MODEL)} };\n`);
  // The ONE line that decides this deployment's topology: a schedule puts a forwarder, a Function URL
  // and an EventBridge rule into the template (plan.ts agentcoreTopology).
  // A plain default export, not `defineRoutine`: that helper is an identity function, so the loader
  // sees the same shape either way, and this fixture then needs no `npm install` before `deploy` reads
  // it. (The deployed image installs the package itself; this file is read on the BUILDER.)
  await writeFile(
    join(agentDir, "routines", `${SCHEDULE}.ts`),
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

/** `routine-fire <name> (<occurrence>): <status> <body>` — the forwarder's one line per delivery. */
const FIRE_LINE = new RegExp(`routine-fire ${SCHEDULE} \\(([^)]+)\\): (\\d+) (.*)`);

/** Poll the forwarder's log group until it has said something about a fire, or the budget runs out. */
async function waitForFire(
  sinceMs: number,
  budgetMs: number,
): Promise<{ occurrence: string; body: string; status: number; raw: string }> {
  const group = forwarderLogGroup(NAME);
  const deadline = Date.now() + budgetMs;
  let lastError = "no forwarder log group yet";
  let seen = 0;
  let lastLine = "";
  while (Date.now() < deadline) {
    // NO `--filter-pattern`. The group holds one Lambda's output, so the server-side term index buys
    // nothing here — and it is a SECOND eventually-consistent thing to wait on: a run whose fires were
    // all delivered and logged still timed out against it, then reported "the log group exists but has
    // logged no routine-fire" while seven `200 {"fired":true}` lines sat in that very group. The regex
    // below already does the matching; this asks only for the stream.
    const events = await aws([
      "logs",
      "filter-log-events",
      "--log-group-name",
      group,
      "--start-time",
      String(sinceMs),
      "--output",
      "json",
    ]);
    if (events.code === 0) {
      const lines = (JSON.parse(events.stdout) as { events?: { message?: string }[] }).events ?? [];
      seen = lines.length;
      lastLine = (lines.at(-1)?.message ?? "").trim().slice(0, 300);
      for (const event of lines) {
        // TRIMMED, because every CloudWatch message ends with a newline and this regex used to anchor on
        // `$`. In Perl and Python that matches before a trailing newline; in JavaScript it does NOT — `$`
        // without `m` is end-of-input only. So the pattern matched nothing real, on every run, while the
        // probe reported "the forwarder logged N lines, none of them a routine-fire" and looked like a
        // delivery problem. The anchor is gone with it: `(.*)` already stops at the newline.
        const matched = FIRE_LINE.exec((event.message ?? "").trim());
        if (matched)
          return {
            occurrence: matched[1] as string,
            status: Number(matched[2]),
            body: matched[3] as string,
            raw: (event.message ?? "").trim(),
          };
      }
      lastError = `the forwarder logged ${seen} line(s), none of them a routine-fire for "${SCHEDULE}"`;
    } else {
      // Absent until first use: AWS creates the group when the Lambda first writes.
      lastError = events.stderr.trim().slice(0, 300);
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  // WHAT IT SAW, not just what it wanted. The previous wording asserted something this function cannot
  // observe ("has logged no routine-fire") and sent a real investigation after the wrong cause twice.
  throw new Error(
    `no routine-fire delivery within ${Math.round(budgetMs / 1000)}s — ${lastError}` +
      (lastLine ? `\n  last line in ${group}: ${lastLine}` : ""),
  );
}

describe("agentcore routines: EventBridge holds the clock and names each fire", () => {
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

    // SIX MINUTES, which the header's own measurement supports and nothing observed contradicts. The
    // routine runs from the minute after the stack is created, so the first delivery's instant is
    // within 60s of this point; the cold invocation then took 61.4s end to end (container start,
    // definition open, model turn), and the poll interval is 10s — about 130s to the first match,
    // against a 360s budget.
    //
    // It was briefly raised to 900s, which was a second patch on a symptom the line above had already
    // explained: the run that timed out had delivered every fire ON TIME and logged them, and what hid
    // them was `--filter-pattern`, not the clock. The budget is a cost ceiling here — one real model
    // turn per minute of it — so it stays at the measured number until something is observed to exceed
    // it. It also has to fit inside this test's own timeout alongside the deploy (~7 minutes measured).
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
