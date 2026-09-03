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
 * COSTS REAL RESOURCES (a full AgentCore stack) and is the slowest probe in the suite: a deploy plus
 * MIN_WAKE_MS plus a teardown. Needs the same AWS credentials as agentcore-deploy, plus
 * `scheduler:ListSchedules` / `scheduler:GetSchedule` — ListSchedules is resource-less, so it must be
 * granted on `*`.
 */
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentcoreName, ingressSessionId, stateBucketName } from "../../src/deploy/agentcore/plan.ts";
import { parseStackOutputs } from "../../src/deploy/agentcore/run.ts";
import { MIN_WAKE_MS } from "../../src/schedule/wakeups.ts";
import { CLI, aws, liveVersion, requireEnv, run } from "./env.ts";

const MODEL = requireEnv("FASTAGENT_LIVE_MODEL", 'the model under test, e.g. "anthropic/claude-sonnet-4-5"');
requireEnv("AWS_ACCESS_KEY_ID", "an AWS key scoped to fastagent-live-probe-* (this probe creates real resources)");
requireEnv("AWS_SECRET_ACCESS_KEY", "the secret for AWS_ACCESS_KEY_ID");
requireEnv("AWS_REGION", "a region where Bedrock AgentCore is available, e.g. us-east-1");

const NAME = agentcoreName(`live-probe-${randomUUID().slice(0, 8)}`);
const STACK = `fastagent-${NAME}`;
const REPO = `fastagent/${NAME}`;
/** The forwarder names every alarm `WAKE_PREFIX + sha256(wakeId)[:16]` (plan.ts). The prefix is all
 *  this probe can predict — the id is minted inside the container. */
const ALARM_PREFIX = `fa-${NAME}-wk-`;

let workspace = "";
let account = "";

beforeAll(async () => {
  const identity = await aws(["sts", "get-caller-identity", "--output", "json"]);
  expect(identity.code, `sts get-caller-identity failed: ${identity.stderr}`).toBe(0);
  account = (JSON.parse(identity.stdout) as { Account: string }).Account;

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
  // Same three places as agentcore-deploy, and here the bucket is REAL: `selfSchedule` turns the
  // forwarder on, which is what makes the driver create a state bucket. The alarms need no cleanup —
  // one-shots self-delete after firing, and the stack's Scheduler group goes with the stack.
  const errors: unknown[] = [];
  const attempt = async (label: string, args: string[]) => {
    const { code, stderr } = await aws(args);
    if (code !== 0 && !/does not exist|NotFound|NoSuchBucket/i.test(stderr)) {
      errors.push(new Error(`${label} failed: ${stderr.slice(0, 500)}`));
    }
  };

  await attempt("delete-stack", ["cloudformation", "delete-stack", "--stack-name", STACK]);
  await attempt("wait stack-delete-complete", [
    "cloudformation",
    "wait",
    "stack-delete-complete",
    "--stack-name",
    STACK,
  ]);
  if (account) {
    const bucket = stateBucketName(NAME, account);
    await attempt("s3 rm", ["s3", "rm", `s3://${bucket}`, "--recursive"]);
    const listed = await aws(["s3api", "list-object-versions", "--bucket", bucket, "--output", "json"]);
    if (listed.code === 0) {
      const payload = JSON.parse(listed.stdout) as {
        Versions?: { Key: string; VersionId: string }[];
        DeleteMarkers?: { Key: string; VersionId: string }[];
      };
      const objects = [...(payload.Versions ?? []), ...(payload.DeleteMarkers ?? [])].map(({ Key, VersionId }) => ({
        Key,
        VersionId,
      }));
      if (objects.length > 0) {
        await attempt("s3api delete-objects", [
          "s3api",
          "delete-objects",
          "--bucket",
          bucket,
          "--delete",
          JSON.stringify({ Objects: objects }),
        ]);
      }
    }
    await attempt("s3 rb", ["s3api", "delete-bucket", "--bucket", bucket]);
  }
  await attempt("ecr delete-repository", ["ecr", "delete-repository", "--repository-name", REPO, "--force"]);

  if (workspace) await rm(workspace, { recursive: true, force: true }).catch((e: unknown) => errors.push(e));
  if (errors.length > 0) {
    throw new AggregateError(errors, `teardown failed — check stack ${STACK}, bucket fa-${NAME}-*, repo ${REPO}`);
  }
}, 900_000);

/** One `invoke` envelope through the runtime, returning the stream body. */
async function invokeRuntime(runtimeArn: string, text: string, label: string): Promise<string> {
  const payload = join(workspace, `${label}.json`);
  const out = join(workspace, `${label}-reply.json`);
  await writeFile(payload, `${JSON.stringify({ kind: "invoke", session: "live-wake", text })}\n`);
  const reply = await aws([
    "bedrock-agentcore",
    "invoke-agent-runtime",
    "--agent-runtime-arn",
    runtimeArn,
    "--runtime-session-id",
    ingressSessionId(NAME),
    "--payload",
    `file://${payload}`,
    "--cli-binary-format",
    "raw-in-base64-out",
    out,
  ]);
  expect(reply.code, `invoke-agent-runtime (${label}) failed:\n${reply.stderr.slice(-2000)}`).toBe(0);
  return await readFile(out, "utf8");
}

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
    const runtimeArn = parseStackOutputs(outputs.stdout).RuntimeArn;
    expect(runtimeArn, `the converged stack has no RuntimeArn output:\n${outputs.stdout.slice(0, 500)}`).toBeTruthy();

    // Nothing has asked for a wake-up yet. Asserted so the alarm found below is THIS run's doing and
    // not a leftover the name prefix happened to match.
    expect(await listAlarms(), "an alarm existed before any wake-up was requested").toHaveLength(0);

    // The delay is the product's floor (MIN_WAKE_MS): shorter is rejected by the guardrail, and
    // longer only makes the probe wait. The tool is NAMED because self-selection is not what this
    // probe is about — see the deferred-tool probe for that distinction.
    const seconds = Math.round(MIN_WAKE_MS / 1000);
    const body = await invokeRuntime(
      runtimeArn as string,
      `Call the wake tool to wake yourself in ${seconds} seconds, then reply with just: scheduled`,
      "wake",
    );
    expect(body, `the wake turn did not complete:\n${body.slice(0, 600)}`).toContain('"type":"completed"');

    // THE assertion. Everything between the tool call and this line is the chain that has no other
    // test: the store write, the sink, the authenticated POST to the forwarder's reserved path, and
    // the forwarder's own IAM creating a schedule. A pending wake-up with no alarm is exactly the
    // silent failure the mechanism exists to prevent.
    const alarms = await listAlarms();
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
    const deadline = Date.now() + MIN_WAKE_MS + 240_000;
    let remaining = await listAlarms();
    while (remaining.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      remaining = await listAlarms();
    }
    expect(
      remaining,
      `the alarm was still registered ${Math.round((Date.now() - (deadline - MIN_WAKE_MS - 240_000)) / 1000)}s later — ` +
        "EventBridge did not deliver it, or the forwarder rejected the poke",
    ).toHaveLength(0);
  }, 1_800_000);
});
