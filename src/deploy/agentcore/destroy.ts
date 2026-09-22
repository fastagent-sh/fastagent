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
import { parseLogGroupNames } from "./logs.ts";
import { deploymentBucketName, forwarderLogGroup, toRuntimeName, wakeAlarmPrefix } from "./plan.ts";

export interface AgentcoreDestroyPlan {
  /** Deployment base name — stack `fastagent-<name>`, bucket `fa-<name>-<account>`, repo `fastagent/<name>`. */
  name: string;
  /** Without it, report what is out there and delete nothing. */
  run: boolean;
}

export type AgentcoreDestroyOutcome =
  /** `found` is what the reads saw; `removed` what the writes did; `kept` what this command refused to delete. */
  | { ok: true; found: string[]; removed: string[]; kept: string[] }
  /**
   * `removed` and `kept` ride along: a half-finished teardown is exactly when "what is already gone" matters
   * most, and the kept bucket is this command's only deliberate decision — it must not vanish from the report
   * because something else failed.
   */
  | { ok: false; gate: string; removed: string[]; kept: string[] };

/** An AWS CLI failure that means the thing is already gone, which is what a teardown is trying to achieve. */
const ABSENT = /does not exist|NotFound|not found|NoSuchBucket|NoSuchEntity|ResourceNotFoundException/i;

/** S3 deletes at most 1000 keys per call. */
const DELETE_BATCH = 1000;

interface Version {
  Key: string;
  VersionId: string;
}

/**
 * GUARDED, like every other read of AWS CLI output in this directory (`parseStackOutputs`,
 * `parseLogGroupNames`): output we cannot read becomes `undefined` and the caller turns it into one actionable
 * line, because an exception escaping this module reaches the operator as a Node stack trace — `src/cli.ts` has
 * no catch-all.
 *
 * EMPTY STDOUT IS AN EMPTY LIST, not a parse failure. The AWS CLI prints NOTHING for a paginated list command
 * with no results, even with `--output json`. An empty artifact bucket is not hypothetical: `create-bucket`
 * happens before the upload into it, and a previous destroy that got through `delete-objects` and failed on
 * `delete-bucket` leaves exactly one — which is the half-deleted deployment this command exists to finish.
 */
function parseVersions(stdout: string): Version[] | undefined {
  if (stdout.trim() === "") return [];
  try {
    const parsed = JSON.parse(stdout) as { Versions?: Version[]; DeleteMarkers?: Version[] };
    // BOTH LISTS: a versioned bucket refuses `delete-bucket` while either is non-empty, which is how a
    // hand-cleanup of this exact account hit `BucketNotEmpty ... You must delete all versions in the bucket`.
    return [...(parsed.Versions ?? []), ...(parsed.DeleteMarkers ?? [])];
  } catch {
    return undefined;
  }
}

/** Wake alarm names, same guard and same empty-output rule as {@link parseVersions}. */
function parseScheduleNames(stdout: string): string[] | undefined {
  if (stdout.trim() === "") return [];
  try {
    return ((JSON.parse(stdout) as { Schedules?: { Name?: unknown }[] }).Schedules ?? []).flatMap((s) =>
      typeof s.Name === "string" ? [s.Name] : [],
    );
  } catch {
    return undefined;
  }
}

/** `aws configure get region` — the profile's region, which the AWS CLI does not take from `AWS_REGION`. */
async function regionFromConfig(aws: CliRunner): Promise<string | undefined> {
  const configured = await aws(["configure", "get", "region"], { capture: true, captureStderr: true });
  return configured.stdout.trim() || undefined;
}

export async function destroyAgentcoreDeployment(
  plan: AgentcoreDestroyPlan,
  aws: CliRunner,
  announce: (message: string) => void = () => {},
): Promise<AgentcoreDestroyOutcome> {
  const gate = (g: string, removed: string[] = [], kept: string[] = []): AgentcoreDestroyOutcome => ({
    ok: false,
    gate: g,
    removed,
    kept,
  });
  const stack = `fastagent-${plan.name}`;
  const repo = `fastagent/${plan.name}`;

  const identity = await aws(["sts", "get-caller-identity", "--output", "json"], {
    capture: true,
    captureStderr: true,
  });
  if (identity.code === 127) {
    return gate("aws CLI not found — install AWS CLI v2: https://docs.aws.amazon.com/cli/, then re-run");
  }
  if (identity.code !== 0) {
    // A MISSING REGION FAILS HERE TOO, and blaming the credentials sends the operator to fix the wrong thing.
    const why = /region/i.test(identity.stderr ?? "")
      ? "no AWS region configured — set AWS_REGION (or `aws configure set region <region>`), then re-run"
      : "no working AWS credentials — run `aws configure` (or set AWS_ACCESS_KEY_ID/…), then re-run";
    return gate(why);
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

  // EVERY RESOURCE BELOW IS REGIONAL, and none of them says so. A default profile pointing somewhere other than
  // the deploy's region answers "nothing in this account", which an operator reads as "already clean" — so the
  // region is resolved and REPORTED the way `run.ts` does it, and its absence is its own gate rather than a
  // credential complaint.
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? (await regionFromConfig(aws));
  if (!region) {
    return gate("no AWS region configured — set AWS_REGION (or `aws configure set region <region>`), then re-run");
  }

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
  const alarms = parseScheduleNames(listed.stdout);
  if (alarms === undefined) {
    return gate(`could not read the wake alarm list under ${prefix} — see the output above`);
  }

  // WHAT IS ACTUALLY THERE, read before anything is deleted. Not for safety — the deletes tolerate a miss — but
  // because this report is the command's entire output, and `aws cloudformation delete-stack` answers 0 for a
  // stack that does not exist. Reporting "deleted: stack X" for a stack nobody deployed is the false signal this
  // repo refuses; the reads are also what the inventory (`destroy` without `--run`) prints.
  // `captureStderr` on every one of these: "does not exist" is the EXPECTED answer here, and letting the AWS
  // CLI print it makes a clean inventory look like three failures.
  // AND `undefined` FOR "I COULD NOT TELL". An exit code alone cannot separate `does not exist` from
  // `AccessDeniedException`, `ThrottlingException` or `ExpiredToken` — and reading a denial as absence is how
  // this command reports "nothing left to delete" over a runtime that is still billing. `ABSENT` is the one
  // place that decides what "already gone" looks like; the alarm and log-group listings beside this already
  // gate on unreadable, and these now match.
  const exists = async (args: string[]): Promise<boolean | undefined> => {
    const { code, stderr } = await aws(args, { capture: true, captureStderr: true });
    return code === 0 ? true : ABSENT.test(stderr ?? "") ? false : undefined;
  };
  const stackExists = await exists(["cloudformation", "describe-stacks", "--stack-name", stack, "--output", "json"]);
  if (stackExists === undefined) {
    return gate(`could not tell whether stack ${stack} exists in ${region} — see the output above`);
  }
  const versions = await aws(["s3api", "list-object-versions", "--bucket", bucket, "--output", "json"], {
    capture: true,
    captureStderr: true,
  });
  const bucketExists = versions.code === 0;
  if (!bucketExists && !ABSENT.test(versions.stderr ?? "")) {
    return gate(`could not tell whether bucket ${bucket} exists — see the output above`);
  }
  const contents = bucketExists ? parseVersions(versions.stdout) : [];
  if (contents === undefined) {
    return gate(`could not read the object listing for bucket ${bucket} — see the output above`);
  }
  const keys = contents.map((v) => v.Key);
  // A bucket that holds anything but the forwarder's zips is NOT ours to delete. Today's deploy puts nothing
  // else there (agent state lives on the AgentCore storage mount), but an older one kept `state/snapshot.json.gz`
  // in it, and in this account those snapshots were the only copy left of two retired agents.
  const foreign = [...new Set(keys.filter((key) => !key.startsWith("forwarder/")))];
  const repoExists = await exists(["ecr", "describe-repositories", "--repository-names", repo, "--output", "json"]);
  if (repoExists === undefined) {
    return gate(`could not tell whether repository ${repo} exists in ${region} — see the output above`);
  }

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
    return gate(`could not list log groups under ${forwarderGroup} in ${region} — see the output above`, []);
  }
  // THE RUNTIME'S GROUP IS NAMED WITHOUT THE STACK. AgentCore's runtime id is `<AgentRuntimeName>-<suffix>`, and
  // the name is `toRuntimeName(plan.name)` — the same derivation the template deployed. Reading it out of the
  // stack's `RuntimeArn` instead meant that the operator whose first move was `aws cloudformation delete-stack`
  // (which `docs/deploy.md` says it will be) then got a clean-looking teardown with the group holding every
  // line the agent ever printed still sitting there. The trailing `-` keeps `probe-` off `probe2-…`.
  const runtimePrefix = `/aws/bedrock-agentcore/runtimes/${toRuntimeName(plan.name)}-`;
  const runtimeGroups = await listLogGroups(runtimePrefix);
  if (runtimeGroups === undefined) {
    return gate(`could not list log groups under ${runtimePrefix} in ${region} — see the output above`, []);
  }
  const logGroups = [...forwarderGroups.filter((name) => name === forwarderGroup), ...runtimeGroups];

  announce(`account ${account}, region ${region}`);

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
    const asked = await aws(["cloudformation", "delete-stack", "--stack-name", stack], { captureStderr: true });
    const refused = asked.code !== 0 && !ABSENT.test(asked.stderr ?? "");
    if (refused) {
      return gate(
        `stack ${stack} refused to delete: ${(asked.stderr ?? "").trim().slice(0, 300)}\n` +
          `  the image and the forwarder package it was built from are untouched, so a retry has what it needs.`,
        removed,
        kept,
      );
    }
    {
      // THE WAIT DECIDES whether anything below may run, AND whether the stack counts as deleted at all.
      // `delete-stack` returning 0 only means CloudFormation accepted the request: a DELETE_FAILED stack still
      // holds a billing Bedrock runtime and Lambda, and the image and the forwarder zip below are what it was
      // created FROM — deleting those while it stands only makes the operator's retry worse. Recording it as
      // removed before this point printed "deleted: stack X" directly above "did not finish deleting".
      const waited = await aws(["cloudformation", "wait", "stack-delete-complete", "--stack-name", stack], {
        captureStderr: true,
      });
      if (waited.code !== 0 && !ABSENT.test(waited.stderr ?? "")) {
        return gate(
          `stack ${stack} did not finish deleting: ${(waited.stderr ?? "").trim().slice(0, 300)}\n` +
            `  its runtime and Lambda are still billing. The image and the forwarder package it was built ` +
            `from are untouched, so a retry has what it needs.`,
          removed,
          kept,
        );
      }
      removed.push(`stack ${stack}`);
      // AGAIN, NOW. The container served the whole deletion and holds `scheduler:CreateSchedule`, so a wake-up
      // taken in those minutes minted an alarm after the first sweep read the list — an alarm whose target is
      // the Lambda we just deleted, retrying into nothing for weeks.
      const after = await aws(["scheduler", "list-schedules", "--name-prefix", prefix, "--output", "json"], {
        capture: true,
        captureStderr: true,
      });
      const late = after.code === 0 ? parseScheduleNames(after.stdout) : undefined;
      if (late === undefined) {
        failures.push(
          `re-listing wake alarms under ${prefix}: ${(after.stderr ?? "unreadable output").trim().slice(0, 300)}`,
        );
      } else {
        await sweepAlarms(late);
      }
    }
  }

  if (bucketExists && foreign.length === 0) await purgeBucket(bucket, aws, attempt, failures);
  if (repoExists) {
    await attempt(`repository ${repo}`, ["ecr", "delete-repository", "--repository-name", repo, "--force"]);
  }
  for (const name of logGroups) {
    await attempt(`log group ${name}`, ["logs", "delete-log-group", "--log-group-name", name]);
  }

  if (failures.length > 0) {
    return gate(`${failures.length} resource(s) survived:\n  ${failures.join("\n  ")}`, removed, kept);
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
  failures: string[],
): Promise<void> {
  // RE-READ rather than reusing the inventory: minutes of `stack-delete-complete` sit between the two.
  const listed = await aws(["s3api", "list-object-versions", "--bucket", bucket, "--output", "json"], {
    capture: true,
    captureStderr: true,
  });
  if (listed.code !== 0) return; // gone between the inventory and now
  const versions = parseVersions(listed.stdout);
  if (versions === undefined) {
    failures.push(`bucket ${bucket}: could not read its object listing, so it was left in place`);
    return;
  }
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
