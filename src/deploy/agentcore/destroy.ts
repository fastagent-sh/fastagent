/**
 * `destroy agentcore`: removing what a deploy created, INCLUDING the parts the stack does not own.
 *
 * `aws cloudformation delete-stack` is the obvious move and it leaves three of the four behind, each for its own
 * reason:
 *
 * - the S3 artifact bucket and the ECR repository must exist BEFORE the stack (it reads the forwarder's zip and
 *   the runtime's image from them), so they cannot be stack resources;
 * - the forwarder's log group is created by AWS on the Lambda's first WRITE, so no template ever mentions it —
 *   and the deploy put a 14-day retention on it, i.e. it holds data;
 * - a wake alarm is minted at RUNTIME by the container. `ActionAfterCompletion: DELETE` only runs once one
 *   FIRES, so anything stopped between the wake call and the fire leaves a schedule that retries into a deleted
 *   Lambda for weeks.
 *
 * Every deletion is ATTEMPTED even after an earlier one fails, and "already gone" is the goal state rather than
 * an error — a teardown that stops at the first miss is one that cannot finish a half-deleted deployment.
 */
import type { CliRunner } from "../runner.ts";
import { parseLogGroupNames, runtimeIdFromArn } from "./logs.ts";
import { deploymentBucketName, forwarderLogGroup, wakeAlarmPrefix } from "./plan.ts";
import { parseStackOutputs } from "./run.ts";

export interface AgentcoreDestroyPlan {
  /** Deployment base name — stack `fastagent-<name>`, bucket `fa-<name>-<account>`, repo `fastagent/<name>`. */
  name: string;
  /** Without it, report what is out there and delete nothing. */
  run: boolean;
}

export type AgentcoreDestroyOutcome =
  /** `found` is what the reads saw; `removed` what the writes did; `kept` what this command refused to delete. */
  | { ok: true; found: string[]; removed: string[]; kept: string[] }
  /** `removed` rides along: a half-finished teardown is exactly when "what is already gone" matters most. */
  | { ok: false; gate: string; removed: string[] };

/** An AWS CLI failure that means the thing is already gone, which is what a teardown is trying to achieve. */
const ABSENT = /does not exist|NotFound|not found|NoSuchBucket|NoSuchEntity|ResourceNotFoundException/i;

/** S3 deletes at most 1000 keys per call. */
const DELETE_BATCH = 1000;

interface Version {
  Key: string;
  VersionId: string;
}

/**
 * Every object AND delete marker in the bucket. The AWS CLI paginates this itself, so one call is the whole
 * bucket — and both lists matter: a versioned bucket refuses `delete-bucket` while either is non-empty, which is
 * how a hand-cleanup of this exact account hit `BucketNotEmpty ... You must delete all versions in the bucket`.
 */
function parseVersions(stdout: string): Version[] {
  const parsed = JSON.parse(stdout) as { Versions?: Version[]; DeleteMarkers?: Version[] };
  return [...(parsed.Versions ?? []), ...(parsed.DeleteMarkers ?? [])];
}

export async function destroyAgentcoreDeployment(
  plan: AgentcoreDestroyPlan,
  aws: CliRunner,
  announce: (message: string) => void = () => {},
): Promise<AgentcoreDestroyOutcome> {
  const gate = (g: string, removed: string[] = []): AgentcoreDestroyOutcome => ({ ok: false, gate: g, removed });
  const stack = `fastagent-${plan.name}`;
  const repo = `fastagent/${plan.name}`;

  const identity = await aws(["sts", "get-caller-identity", "--output", "json"], { capture: true });
  if (identity.code === 127) {
    return gate("aws CLI not found — install AWS CLI v2: https://docs.aws.amazon.com/cli/, then re-run");
  }
  if (identity.code !== 0) {
    return gate("no working AWS credentials — run `aws configure` (or set AWS_ACCESS_KEY_ID/…), then re-run");
  }
  let account: string;
  try {
    const parsed = JSON.parse(identity.stdout) as { Account?: unknown };
    if (typeof parsed.Account !== "string") throw new Error("no Account");
    account = parsed.Account;
  } catch {
    return gate("could not read the account id from `aws sts get-caller-identity` — see the output above");
  }
  const bucket = deploymentBucketName(plan.name, account);

  // The alarm ids are minted inside the container, so the PREFIX is all we can ask for. An unreadable list is
  // indistinguishable from an empty one, and the difference is whether something out there is still firing.
  const prefix = wakeAlarmPrefix(plan.name);
  const listed = await aws(["scheduler", "list-schedules", "--name-prefix", prefix, "--output", "json"], {
    capture: true,
    captureStderr: true,
  });
  if (listed.code !== 0) {
    return gate(`could not list wake alarms under ${prefix}: ${(listed.stderr ?? "").trim().slice(0, 300)}`);
  }
  const alarms = ((JSON.parse(listed.stdout) as { Schedules?: { Name: string }[] }).Schedules ?? []).map((s) => s.Name);

  // WHAT IS ACTUALLY THERE, read before anything is deleted. Not for safety — the deletes tolerate a miss — but
  // because this report is the command's entire output, and `aws cloudformation delete-stack` answers 0 for a
  // stack that does not exist. Reporting "deleted: stack X" for a stack nobody deployed is the false signal this
  // repo refuses; the reads are also what the inventory (`destroy` without `--run`) prints.
  // `captureStderr` on every one of these: "does not exist" is the EXPECTED answer here, and letting the AWS
  // CLI print it makes a clean inventory look like three failures.
  const exists = async (args: string[]): Promise<boolean> =>
    (await aws(args, { capture: true, captureStderr: true })).code === 0;
  const stackExists = await exists(["cloudformation", "describe-stacks", "--stack-name", stack, "--output", "json"]);
  const versions = await aws(["s3api", "list-object-versions", "--bucket", bucket, "--output", "json"], {
    capture: true,
    captureStderr: true,
  });
  const bucketExists = versions.code === 0;
  const keys = bucketExists ? parseVersions(versions.stdout).map((v) => v.Key) : [];
  // A bucket that holds anything but the forwarder's zips is NOT ours to delete. Today's deploy puts nothing
  // else there (agent state lives on the AgentCore storage mount), but an older one kept `state/snapshot.json.gz`
  // in it, and in this account those snapshots were the only copy left of two retired agents.
  const foreign = [...new Set(keys.filter((key) => !key.startsWith("forwarder/")))];
  const repoExists = await exists(["ecr", "describe-repositories", "--repository-names", repo, "--output", "json"]);

  // BOTH LOG GROUPS, and the runtime's has to be resolved while the stack still stands: its name carries the
  // runtime id, which only the stack's outputs know. AWS creates each on the first WRITE, so neither is a stack
  // resource — same reason, twice — and the runtime's holds the agent's own stdout/stderr, i.e. what it said in
  // every conversation. `deploy`'s runbook already knows there are two: it sets a retention on each.
  const forwarderGroup = forwarderLogGroup(plan.name);
  const listLogGroups = async (prefix: string): Promise<string[] | undefined> => {
    const listed = await aws(
      [
        "logs",
        "describe-log-groups",
        "--log-group-name-prefix",
        prefix,
        "--query",
        "logGroups[].logGroupName",
        "--output",
        "json",
      ],
      { capture: true, captureStderr: true },
    );
    return listed.code === 0 ? parseLogGroupNames(listed.stdout) : undefined;
  };
  const forwarderGroups = await listLogGroups(forwarderGroup);
  if (forwarderGroups === undefined) {
    return gate(`could not list log groups under ${forwarderGroup} — check the AWS account/region above`, []);
  }
  const logGroups = forwarderGroups.filter((name) => name === forwarderGroup);
  if (stackExists) {
    const outputs = await aws(
      ["cloudformation", "describe-stacks", "--stack-name", stack, "--query", "Stacks[0].Outputs", "--output", "json"],
      { capture: true, captureStderr: true },
    );
    const runtimeArn = outputs.code === 0 ? parseStackOutputs(outputs.stdout).RuntimeArn : undefined;
    const runtimeId = runtimeArn && runtimeIdFromArn(runtimeArn);
    if (runtimeId) {
      const runtimeGroups = await listLogGroups(`/aws/bedrock-agentcore/runtimes/${runtimeId}-`);
      if (runtimeGroups === undefined) {
        return gate(`could not list log groups for runtime ${runtimeId} — check the AWS account/region above`, []);
      }
      logGroups.push(...runtimeGroups);
    }
  }

  const found: string[] = [];
  if (alarms.length > 0) found.push(`${alarms.length} wake alarm(s) under ${prefix}`);
  if (stackExists) found.push(`stack ${stack}`);
  if (bucketExists) found.push(`bucket ${bucket} (${keys.length} object version(s))`);
  if (repoExists) found.push(`repository ${repo}`);
  for (const name of logGroups) found.push(`log group ${name}`);

  // The one thing this command refuses: a bucket holding anything but the forwarder's zips.
  const kept =
    foreign.length > 0
      ? [
          `bucket ${bucket} — it holds ${foreign.join(", ")}, which no deploy of this version writes. Read it, ` +
            `then \`aws s3 rb s3://${bucket} --force\` if you want it gone`,
        ]
      : [];
  if (!plan.run) return { ok: true, found, removed: [], kept };

  const removed: string[] = [];
  const failures: string[] = [];
  const attempt = async (label: string, args: string[]): Promise<boolean> => {
    const { code, stderr } = await aws(args, { captureStderr: true });
    if (code === 0) {
      removed.push(label);
      return true;
    }
    if (ABSENT.test(stderr ?? "")) return true; // already gone: the goal state
    failures.push(`${label}: ${(stderr ?? "").trim().slice(0, 300)}`);
    return false;
  };

  const swept = new Set<string>();
  const sweepAlarms = async (names: string[]) => {
    for (const alarm of names.filter((name) => !swept.has(name))) {
      swept.add(alarm);
      await attempt(`wake alarm ${alarm}`, ["scheduler", "delete-schedule", "--name", alarm]);
    }
  };
  await sweepAlarms(alarms);

  if (stackExists) {
    announce(`deleting stack ${stack} (this waits for CloudFormation)…`);
    if (await attempt(`stack ${stack}`, ["cloudformation", "delete-stack", "--stack-name", stack])) {
      // THE WAIT DECIDES whether anything below may run. A DELETE_FAILED stack still holds a billing Bedrock
      // runtime and Lambda, and the image and the forwarder zip below are what it was created FROM — deleting
      // those while it stands only makes the operator's retry worse. `run.ts` gates on this same command.
      const waited = await aws(["cloudformation", "wait", "stack-delete-complete", "--stack-name", stack], {
        captureStderr: true,
      });
      if (waited.code !== 0 && !ABSENT.test(waited.stderr ?? "")) {
        return gate(
          `stack ${stack} did not finish deleting: ${(waited.stderr ?? "").trim().slice(0, 300)}\n` +
            `  its runtime and Lambda are still billing. Nothing else was touched — the image and the ` +
            `forwarder package it was built from are still in place for a retry.`,
          removed,
        );
      }
      // AGAIN, NOW. The container served the whole deletion and holds `scheduler:CreateSchedule`, so a wake-up
      // taken in those minutes minted an alarm after the first sweep read the list — an alarm whose target is
      // the Lambda we just deleted, retrying into nothing for weeks.
      const after = await aws(["scheduler", "list-schedules", "--name-prefix", prefix, "--output", "json"], {
        capture: true,
        captureStderr: true,
      });
      if (after.code !== 0) {
        failures.push(`re-listing wake alarms under ${prefix}: ${(after.stderr ?? "").trim().slice(0, 300)}`);
      } else {
        await sweepAlarms(
          ((JSON.parse(after.stdout) as { Schedules?: { Name: string }[] }).Schedules ?? []).map((a) => a.Name),
        );
      }
    }
  }

  if (bucketExists && foreign.length === 0) await purgeBucket(bucket, aws, attempt);
  if (repoExists) {
    await attempt(`repository ${repo}`, ["ecr", "delete-repository", "--repository-name", repo, "--force"]);
  }
  for (const name of logGroups) {
    await attempt(`log group ${name}`, ["logs", "delete-log-group", "--log-group-name", name]);
  }

  if (failures.length > 0) {
    return gate(`${failures.length} resource(s) survived:\n  ${failures.join("\n  ")}`, removed);
  }
  return { ok: true, found, removed, kept };
}

/**
 * Empty the bucket, then delete it. The emptying is not optional even for a bucket that was never versioned:
 * `delete-bucket` refuses a non-empty one, and the forwarder's zips are always in there.
 */
async function purgeBucket(
  bucket: string,
  aws: CliRunner,
  attempt: (label: string, args: string[]) => Promise<boolean>,
): Promise<void> {
  const listed = await aws(["s3api", "list-object-versions", "--bucket", bucket, "--output", "json"], {
    capture: true,
    captureStderr: true,
  });
  if (listed.code !== 0) return; // gone between the inventory and now
  const versions = parseVersions(listed.stdout);
  for (let at = 0; at < versions.length; at += DELETE_BATCH) {
    const batch = versions.slice(at, at + DELETE_BATCH).map((v) => ({ Key: v.Key, VersionId: v.VersionId }));
    await attempt(`${batch.length} object version(s) in ${bucket}`, [
      "s3api",
      "delete-objects",
      "--bucket",
      bucket,
      "--delete",
      JSON.stringify({ Objects: batch, Quiet: true }),
    ]);
  }
  await attempt(`bucket ${bucket}`, ["s3api", "delete-bucket", "--bucket", bucket]);
}
