/**
 * The wake-alarm mechanism against real AWS: an agent schedules its own follow-up, and the deployment
 * turns that into an EventBridge one-shot that will poke it back awake.
 *
 * WHY THIS NEEDS A LIVE PROBE. On a host with no resident process, a `wake` is not a timer someone is
 * holding — it is a round trip through three systems (wake-alarm.ts):
 *
 *   wake tool → wakeups store → the sink → POST the full pending set to the forwarder's reserved path
 *   → the forwarder (AWS SDK + IAM role) mirrors each wake-up into a one-shot `at(fireAt)` schedule
 *   → EventBridge pokes the forwarder at the instant → InvokeAgentRuntime wakes the container
 *   → the boot / 30s pump finds the due entry and fires it
 *
 * Offline, every arrow but the first is a stub. The one this probe is FOR is the middle one: the
 * container POSTing to its own forwarder, and the forwarder having exactly the IAM it needs to create
 * a schedule. Three things have to be simultaneously right (the wake secret both sides received, the
 * forwarder's role, the Scheduler API call), none of them is exercised by any other test, and the
 * failure mode is silent — a pending wake-up with no alarm behind it, which is the reliability hole
 * this whole mechanism exists to close.
 *
 * WHERE THE ASSERTIONS STOP, and why. Creating the alarm is checked directly. The FIRE is checked
 * weakly — the schedule carries `ActionAfterCompletion: DELETE`, so its disappearance is evidence it
 * ran, but disappearance has other causes and this probe cannot tell them apart. The last two arrows
 * (poke → container awake → pump fires the turn) are NOT covered: observing them means pulling the
 * state snapshot out of S3 and reading session records, which costs more than it settles here — that
 * half is AWS delivering a schedule it accepted, where the half above is our code and our IAM.
 *
 * IT ALSO CARRIES THE INGRESS ASSERTIONS, for the reason the fixture list makes unavoidable: this is
 * the only probe whose deployment HAS a forwarder and a Function URL, so the gates on that URL are
 * reachable from nowhere else. They ride on the stack this probe already paid for.
 *
 * COSTS REAL RESOURCES (a full AgentCore stack) and is the slowest probe in the suite: a deploy plus
 * the wake delay plus a teardown. It also needs MORE IAM than agentcore-deploy, in two ways that both
 * fail late — after the image is built and pushed — so they are listed where a policy author will see
 * them (.github/workflows/live.yml carries the same list):
 *
 *   scheduler:ListSchedules   reading the alarm back, and the teardown. RESOURCE-LESS: `*` or nothing.
 *   scheduler:GetSchedule     the expression and completion action, which the list summary omits.
 *   scheduler:DeleteSchedule  teardown, here and in the workflow sweep.
 *
 * And this is the first fixture with `selfSchedule: true`, i.e. the first `topology.forwarder` deployment:
 * the forwarder Lambda, its Function URL, the wake role (iam:CreateRole / PassRole / AttachRolePolicy)
 * and a VERSIONED state bucket (s3:PutBucketVersioning, PutLifecycleConfiguration) are all created
 * here and nowhere else in the suite.
 */
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_WEBHOOK_BODY_BYTES } from "../../src/channels/agentcore-limits.ts";
import { agentcoreName } from "../../src/deploy/agentcore/plan.ts";
import { parseStackOutputs } from "../../src/deploy/agentcore/run.ts";
import { MIN_WAKE_MS } from "../../src/schedule/wakeups.ts";
import {
  CLI,
  aws,
  destroyAgentcoreDeployment,
  invokeAgentcore,
  liveVersion,
  requireAwsAccount,
  requireEnv,
  run,
} from "./env.ts";

const MODEL = requireEnv("FASTAGENT_LIVE_MODEL", 'the model under test, e.g. "anthropic/claude-sonnet-4-5"');

const NAME = agentcoreName(`live-probe-${randomUUID().slice(0, 8)}`);
const STACK = `fastagent-${NAME}`;
/** The forwarder names every alarm `WAKE_PREFIX + sha256(wakeId)[:16]` (plan.ts). The prefix is all
 *  this probe can predict — the id is minted inside the container. */
const ALARM_PREFIX = `fa-${NAME}-wk-`;

/** ABOVE the floor, never ON it. `wake` reads the clock TWICE — `new Date(now() + ms)`, then
 *  `addWakeup(…, now())` — and the guardrail compares them strictly (`fireAt < now + MIN_WAKE_MS`), so
 *  asking for exactly MIN_WAKE_MS is a coin flip on a millisecond boundary. Losing it is worse than it
 *  sounds: the turn still completes, and the rejection surfaces on the alarm assertion below, which
 *  blames the wake secret and the forwarder's IAM. Half a minute of clearance costs the probe nothing
 *  against a 240s poll budget. */
const WAKE_MS = MIN_WAKE_MS + 30_000;

let workspace = "";
let account = "";
/** Read off the converged stack by the probe below, consumed by the ingress assertions after it. */
let forwarderUrl = "";

beforeAll(async () => {
  // 45 = this probe's own declared budgets, 30 minutes for the deploy plus 15 for teardown.
  account = await requireAwsAccount(45);

  if (process.env.RUNNER_TEMP) await appendFile(join(process.env.RUNNER_TEMP, "agentcore-probe-names"), `${NAME}\n`);

  workspace = join(tmpdir(), NAME);
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "persona.md"), "You are terse. Answer in as few words as possible.\n");
  // `selfSchedule` is what puts the whole mechanism in the deployment: it mounts the `wake` tool in the
  // container (open.ts, serving + selfSchedule), and it puts the forwarder, its Function URL and the
  // wake/scheduler IAM into the template. Without it there is no chain to test.
  await writeFile(
    join(workspace, "fastagent.config.mjs"),
    `export default { model: ${JSON.stringify(MODEL)}, selfSchedule: true };\n`,
  );
  await writeFile(
    join(workspace, "package.json"),
    `${JSON.stringify(
      {
        name: "live-agentcore-wake-probe",
        private: true,
        dependencies: { "@fastagent-sh/fastagent": await liveVersion() },
      },
      null,
      2,
    )}\n`,
  );
});

afterAll(async () => {
  // FOUR places, not the three this fixture's resources suggest — the wake alarms are the extra one,
  // and {@link destroyAgentcoreDeployment} takes all four (it sweeps alarms for every fixture, which
  // is why this probe adds no teardown of its own). `finally`, not a catch: the AWS failure still
  // throws, and the temp directory still goes.
  try {
    await destroyAgentcoreDeployment(NAME, account);
  } finally {
    if (workspace) await rm(workspace, { recursive: true, force: true });
  }
}, 900_000);

/** What ListSchedules actually returns per entry: a SUMMARY. Measured against the API, not assumed —
 *  there is no `ScheduleExpression` on it, which is why that assertion goes through {@link getAlarm}. */
interface AlarmSummary {
  Name: string;
  State?: string;
  Target?: { Arn?: string };
}

async function listAlarms(): Promise<AlarmSummary[]> {
  const listed = await aws(["scheduler", "list-schedules", "--name-prefix", ALARM_PREFIX, "--output", "json"]);
  expect(listed.code, `scheduler list-schedules failed: ${listed.stderr}`).toBe(0);
  return (JSON.parse(listed.stdout) as { Schedules?: AlarmSummary[] }).Schedules ?? [];
}

/** The full schedule: only `get-schedule` carries the expression and the completion action. */
async function getAlarm(name: string): Promise<{ ScheduleExpression?: string; ActionAfterCompletion?: string }> {
  const got = await aws(["scheduler", "get-schedule", "--name", name, "--output", "json"]);
  expect(got.code, `scheduler get-schedule ${name} failed: ${got.stderr}`).toBe(0);
  return JSON.parse(got.stdout) as { ScheduleExpression?: string; ActionAfterCompletion?: string };
}

describe("agentcore wake alarms: a self-scheduled wake-up becomes an EventBridge one-shot", () => {
  it("the container registers an alarm with the forwarder, and it fires", async () => {
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
    const runtimeArn = stackOutputs.RuntimeArn;
    expect(runtimeArn, `the converged stack has no RuntimeArn output:\n${outputs.stdout.slice(0, 500)}`).toBeTruthy();
    forwarderUrl = (stackOutputs.ForwarderUrl ?? "").replace(/\/$/, "");
    expect(
      forwarderUrl,
      `the converged stack has no ForwarderUrl output:\n${outputs.stdout.slice(0, 500)}`,
    ).toBeTruthy();

    // Nothing has asked for a wake-up yet. Asserted so the alarm found below is THIS run's doing and
    // not a leftover the name prefix happened to match.
    expect(await listAlarms(), "an alarm existed before any wake-up was requested").toHaveLength(0);

    // The wake tool is NAMED because self-selection is not what this probe is about — see the
    // deferred-tool probe for that distinction. The woken turn's `prompt` is DICTATED for a sharper
    // reason: it is free text the model chooses, and a model that echoes this instruction into it
    // arms a SECOND wake-up when the first fires. That one is created after teardown has listed the
    // alarms, so it outlives the forwarder it points at — the orphan this suite already grew once.
    const seconds = Math.round(WAKE_MS / 1000);
    const body = await invokeAgentcore({
      runtimeArn: runtimeArn as string,
      name: NAME,
      session: "live-wake",
      text:
        `Call the wake tool exactly once, with in: ${seconds} and prompt: "Reply with just: awake". ` +
        "Then reply with just: scheduled",
      dir: workspace,
      label: "wake",
    });
    expect(body, `the wake turn did not complete:\n${body.slice(0, 600)}`).toContain('"type":"completed"');

    // THE assertion. Everything between the tool call and this line is the chain that has no other
    // test: the store write, the sink, the authenticated POST to the forwarder's reserved path, and
    // the forwarder's own IAM creating a schedule. A pending wake-up with no alarm is exactly the
    // silent failure the mechanism exists to prevent.
    //
    // POLLED, not read once. The alarm trails the reply: the sink is fire-and-forget (`void
    // reconcile(…)` in wake-alarm.ts, retrying at 2s/4s/6s) and the SSE stream this invoke consumes
    // does not wait for in-flight work, so `invoke-agent-runtime` can return before a cold forwarder
    // Lambda has created anything. A single read would report that race in the words below — sending
    // whoever reads it after the IAM and the wake secret, neither of which was wrong.
    const appearBy = Date.now() + 60_000;
    let alarms = await listAlarms();
    while (alarms.length === 0 && Date.now() < appearBy) {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      alarms = await listAlarms();
    }
    expect(
      alarms,
      "the wake-up never became an EventBridge alarm — the container's POST to the forwarder, its wake " +
        "secret, or the forwarder's scheduler IAM is broken (all three are silent from inside the agent)",
    ).toHaveLength(1);
    // It must target THIS deployment's forwarder: the poke goes wherever this points, and the name
    // prefix alone would be satisfied by an alarm aimed anywhere.
    expect(alarms[0]?.Target?.Arn, `the alarm targets something else: ${alarms[0]?.Target?.Arn}`).toContain(
      `${STACK}-forwarder`,
    );

    const alarm = await getAlarm(alarms[0]?.Name as string);
    // `at(...)` and nothing else: a rate/cron expression here would mean a one-shot became recurring,
    // which on this path is an agent poking itself forever.
    expect(alarm.ScheduleExpression, `not a one-shot: ${alarm.ScheduleExpression}`).toMatch(/^at\(/);
    // What makes the disappearance below mean anything at all.
    expect(alarm.ActionAfterCompletion, "a fired alarm would not clean itself up").toBe("DELETE");

    // The weak half, stated as such in the header: `ActionAfterCompletion: DELETE` means a fired
    // schedule removes itself, so disappearance is evidence it ran — evidence this probe cannot
    // separate from other causes. Worth the wait anyway: an alarm that is still there well past its
    // instant means EventBridge never delivered, and nothing else in the suite would say so.
    const waitStarted = Date.now();
    const deadline = waitStarted + WAKE_MS + 240_000;
    let remaining = await listAlarms();
    while (remaining.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      remaining = await listAlarms();
    }
    expect(
      remaining,
      `the alarm was still registered ${Math.round((Date.now() - waitStarted) / 1000)}s later — ` +
        "EventBridge did not deliver it, or the forwarder rejected the poke",
    ).toHaveLength(0);
  }, 1_800_000);
});

/**
 * The public half of the same deployment. This fixture declares NO webhook channel, so its Function URL
 * exists only for the container's own callbacks — every ordinary request must be refused, and WHICH
 * refusal comes first is the assertion: an oversized body is rejected by the forwarder BEFORE the
 * webhooks gate, i.e. before anything can spend an AgentCore wake-up on it (the cost/DoS path).
 *
 * Offline, `agentcore-forwarder.test.ts` executes the same source under a fake `require` and pins both
 * answers. What only a real Function URL can say is that the ceiling ARRIVED: it rides in as the
 * template's `MAX_WEBHOOK_BODY_BYTES` env var, and a Lambda that never received it compares against
 * `NaN` — every comparison false, the limit silently gone.
 */
describe("agentcore ingress: the forwarder's Function URL refuses what it must", () => {
  const post = (body: string) =>
    fetch(`${forwarderUrl}/telegram`, { method: "POST", headers: { "content-type": "text/plain" }, body });

  it("refuses ordinary traffic on a schedule-only URL, and an oversized body before that", async () => {
    expect(forwarderUrl, "the deploy above did not converge — nothing to probe").toBeTruthy();

    const ordinary = await post("x");
    expect(ordinary.status, "a URL with no webhook channel behind it served ordinary traffic").toBe(404);

    // Under Lambda's own 6 MB request cap, so what answers is the forwarder and not the platform. The
    // BODY is asserted for exactly that reason: AWS refuses an over-cap request with the same status.
    const oversized = await post("x".repeat(MAX_WEBHOOK_BODY_BYTES + 1));
    expect(oversized.status, "the advertised body ceiling is not enforced on the deployed forwarder").toBe(413);
    expect(await oversized.text(), "the 413 is Lambda's own, not the forwarder's").toContain("payload too large");
  }, 300_000);
});
