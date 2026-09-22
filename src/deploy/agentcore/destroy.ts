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
 * This file is the RESOURCE LIST, the order the dependencies demand, and one policy decision per resource for
 * what to do when AWS cannot answer. What an AWS answer MEANS — there, gone, or unreadable — belongs to
 * {@link awsCli} and is not re-decided here; that repetition is what eleven call sites of it cost.
 *
 * Every deletion is ATTEMPTED even after an earlier one fails, and "already gone" is the goal state rather than
 * an error — a teardown that stops at the first miss is one that cannot finish a half-deleted deployment. The
 * exception is the stack, whose wait gates the rest: the image and the forwarder package below it are what a
 * retry needs.
 */
import type { CliRunner } from "../runner.ts";
import { awsCli, awsJson, parseLogGroupNames } from "./aws-cli.ts";
import {
  agentcoreRepoName,
  agentcoreStackName,
  deploymentBucketName,
  forwarderLogGroup,
  runtimeLogGroupPrefix,
  toRuntimeName,
  wakeAlarmPrefix,
} from "./plan.ts";

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
   * The same three ride along on a failure: a half-finished teardown is exactly when "what is out there" and
   * "what is already gone" matter most, and the kept bucket is this command's only deliberate decision — none
   * of them may vanish from the report because something else failed.
   */
  | { ok: false; gate: string; found: string[]; removed: string[]; kept: string[] };

/** S3 deletes at most 1000 keys per call. */
const DELETE_BATCH = 1000;

interface Version {
  Key: string;
  VersionId: string;
}

/**
 * Every object AND delete marker in the bucket — both, because a versioned bucket refuses `delete-bucket` while
 * either is non-empty, which is how a hand-cleanup of this exact account hit
 * `BucketNotEmpty ... You must delete all versions in the bucket`.
 *
 * AN EMPTY BUCKET is an ordinary answer, and a real one: `create-bucket` happens before the upload into it, and
 * a previous destroy that got through `delete-objects` and failed on `delete-bucket` leaves exactly one — the
 * half-deleted deployment this command exists to finish. AWS says it with a document that simply has neither
 * key (measured: `{"RequestCharged": null, "Prefix": ""}`), which is why `??` here and not a special case.
 */
const parseVersions = awsJson<Version[]>((parsed) => {
  const { Versions, DeleteMarkers } = parsed as { Versions?: Version[]; DeleteMarkers?: Version[] };
  return [...(Versions ?? []), ...(DeleteMarkers ?? [])];
});

const parseScheduleNames = awsJson<string[]>((parsed) =>
  ((parsed as { Schedules?: { Name?: unknown }[] }).Schedules ?? []).flatMap((s) =>
    typeof s.Name === "string" ? [s.Name] : [],
  ),
);

const parseAccountId = awsJson<string>((parsed) => {
  const { Account } = parsed as { Account?: unknown };
  return typeof Account === "string" ? Account : undefined;
});

export async function destroyAgentcoreDeployment(
  plan: AgentcoreDestroyPlan,
  runner: CliRunner,
  announce: (message: string) => void = () => {},
): Promise<AgentcoreDestroyOutcome> {
  const aws = awsCli(runner);
  const gate = (
    g: string,
    parts: { found?: string[]; removed?: string[]; kept?: string[] } = {},
  ): AgentcoreDestroyOutcome => ({
    ok: false,
    gate: g,
    found: parts.found ?? [],
    removed: parts.removed ?? [],
    kept: parts.kept ?? [],
  });
  const stack = agentcoreStackName(plan.name);
  const repo = agentcoreRepoName(plan.name);

  const identity = await aws.read(["sts", "get-caller-identity", "--output", "json"], parseAccountId);
  if (!("ok" in identity)) {
    if ("absent" in identity) return gate("`aws sts get-caller-identity` found no caller — check your profile");
    if (identity.code === 127) return gate(`${identity.unreadable}, then re-run`);
    // A MISSING REGION FAILS HERE TOO, and blaming the credentials sends the operator to fix the wrong thing.
    return gate(
      /region/i.test(identity.unreadable)
        ? "no AWS region configured — set AWS_REGION (or `aws configure set region <region>`), then re-run"
        : `no working AWS credentials — run \`aws configure\` (or set AWS_ACCESS_KEY_ID/…), then re-run: ${identity.unreadable}`,
    );
  }
  const account = identity.ok;
  const bucket = deploymentBucketName(plan.name, account);

  // EVERY RESOURCE BELOW IS REGIONAL, and none of them says so. A default profile pointing somewhere other than
  // the deploy's region answers "nothing in this account", which an operator reads as "already clean" — so the
  // region is resolved and REPORTED the way `run.ts` does it, and its absence is its own gate rather than a
  // credential complaint. `aws configure get region` because the CLI does not take it from `AWS_REGION`.
  const configured = await aws.read(["configure", "get", "region"], (stdout) => stdout.trim());
  const fromConfig = "ok" in configured ? configured.ok : "";
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? fromConfig;
  if (!region) {
    return gate("no AWS region configured — set AWS_REGION (or `aws configure set region <region>`), then re-run");
  }

  // BEFORE THE READS, not after: every gate below names the account or the region, and the operator pointed at
  // the wrong profile has to be able to see that from the line above the failure.
  announce(`account ${account}, region ${region}`);

  // ---- What is out there. Each read gets its own policy for "AWS could not answer". ----

  // The alarm ids are minted inside the container, so the PREFIX is all we can ask for. Unreadable is a gate
  // here: an alarm nobody deleted keeps firing at a Lambda that is about to stop existing.
  const prefix = wakeAlarmPrefix(plan.name);
  const listed = await aws.read(
    ["scheduler", "list-schedules", "--name-prefix", prefix, "--output", "json"],
    parseScheduleNames,
  );
  if ("unreadable" in listed) return gate(`could not list wake alarms under ${prefix}: ${listed.unreadable}`);
  // THE FULL SHAPE, not just the prefix. The forwarder mints every alarm as prefix + sha256(wakeId)[:16]
  // (plan.ts / forwarder.js), and a prefix alone is ambiguous between sibling agents: a workspace literally
  // named `<name>-wk-abc` produces `fa-<name>-wk-abc-wk-<hash>`, which starts with THIS deployment's prefix.
  // Deleting it would take a live deployment's pending wake-ups, and a wake-up is not re-created.
  const isMintedAlarm = (alarm: string) =>
    alarm.startsWith(prefix) && /^[0-9a-f]{16}$/.test(alarm.slice(prefix.length));
  const alarms = ("ok" in listed ? listed.ok : []).filter(isMintedAlarm);

  // A GATE for these three, because they decide whether the REPORT is true. `delete-stack` answers 0 for a
  // stack that does not exist, so "deleted: stack X" for a stack nobody deployed — or "nothing left to delete"
  // over a runtime that is still billing — is the false signal this repo refuses.
  const stackRead = await aws.present(["cloudformation", "describe-stacks", "--stack-name", stack, "--output", "json"]);
  if ("unreadable" in stackRead) {
    return gate(`could not tell whether stack ${stack} exists in ${region}: ${stackRead.unreadable}`);
  }
  const stackExists = "ok" in stackRead;

  const bucketRead = await aws.read(
    ["s3api", "list-object-versions", "--bucket", bucket, "--output", "json"],
    parseVersions,
  );
  if ("unreadable" in bucketRead) {
    return gate(`could not read the object listing for bucket ${bucket} in ${region}: ${bucketRead.unreadable}`);
  }
  const bucketExists = "ok" in bucketRead;
  const keys = ("ok" in bucketRead ? bucketRead.ok : []).map((v) => v.Key);
  // A bucket that holds anything but the forwarder's zips is NOT ours to delete. Today's deploy puts nothing
  // else there (agent state lives on the AgentCore storage mount), but an older one kept `state/snapshot.json.gz`
  // in it, and in this account those snapshots were the only copy left of two retired agents.
  const foreign = [...new Set(keys.filter((key) => !key.startsWith("forwarder/")))];

  const repoRead = await aws.present(["ecr", "describe-repositories", "--repository-names", repo, "--output", "json"]);
  if ("unreadable" in repoRead) {
    return gate(`could not tell whether repository ${repo} exists in ${region}: ${repoRead.unreadable}`);
  }
  const repoExists = "ok" in repoRead;

  // BOTH LOG GROUPS. AWS creates each on the first WRITE, so neither is a stack resource — same reason, twice —
  // and the runtime's holds the agent's own stdout/stderr, i.e. what it said in every conversation. `deploy`'s
  // runbook already knows there are two: it sets a retention on each.
  //
  // THE RUNTIME'S GROUP IS NAMED WITHOUT THE STACK. MEASURED (ap-southeast-1, 2026-09-22): a deploy of
  // `destroy-probe-yehg` produced `/aws/bedrock-agentcore/runtimes/destroy_probe_yehg-6oR1zq7pBZ-DEFAULT`, so
  // the id is `<AgentRuntimeName>-<suffix>` and the name is `toRuntimeName(plan.name)`, the same derivation the
  // template deployed. That account also held ELEVEN of these groups from past deployments whose every other
  // resource was long gone — this is the leak, not a hypothetical one. Reading the name out of the
  // stack's `RuntimeArn` instead meant that the operator whose first move was `aws cloudformation delete-stack`
  // (which `docs/deploy.md` says it will be) got a clean-looking teardown with the group holding every line the
  // agent ever printed still sitting there. The trailing `-` keeps `probe-` off `probe2-…`.
  const forwarderGroup = forwarderLogGroup(plan.name);
  const runtimePrefix = runtimeLogGroupPrefix(toRuntimeName(plan.name));
  const logGroupsUnder = async (prefix: string) =>
    aws.read(
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
      parseLogGroupNames,
    );
  const forwarderRead = await logGroupsUnder(forwarderGroup);
  const runtimeRead = await logGroupsUnder(runtimePrefix);

  // NOT A GATE, unlike the three above: these two only supply NAMES, and refusing to delete anything because a
  // listing failed turned a role without `logs:DescribeLogGroups` — or one `ThrottlingException` — into a
  // permanent no-op with a Bedrock runtime and a Lambda billing behind it.
  //
  // FAILURE vs WARNING is decided by whether the resource SURVIVES it, not by whether a call failed. The
  // forwarder's group is named exactly, so a `--run` deletes it by name and the failed listing changed nothing
  // — reporting `1 resource(s) survived` for a teardown that removed everything is the same false signal as the
  // reverse, and `test/live/env.ts` treats it as a leak. In the inventory, where no delete follows, the same
  // unreadable listing DOES mean the answer is incomplete.
  const failures: string[] = [];
  const warnings: string[] = [];
  const named = (read: Awaited<ReturnType<typeof logGroupsUnder>>) => ("ok" in read ? read.ok : []);
  if ("unreadable" in forwarderRead) {
    (plan.run ? warnings : failures).push(
      plan.run
        ? `could not list log groups under ${forwarderGroup} (${forwarderRead.unreadable}) — deleted it by name instead`
        : `listing log groups under ${forwarderGroup} (${forwarderRead.unreadable}) — cannot confirm whether it exists`,
    );
  }
  if ("unreadable" in runtimeRead) {
    // A failure in BOTH modes — this one carries a suffix only AWS knows, so nothing downstream can address it
    // — but an inventory deletes nothing, so saying it "was NOT deleted" there names the wrong problem.
    failures.push(
      `listing log groups under ${runtimePrefix} (${runtimeRead.unreadable}) — the runtime's log group holds ` +
        (plan.run ? `the agent's stdout and was NOT deleted` : `the agent's stdout and cannot be named`),
    );
  }
  for (const warning of warnings) announce(warning);
  const listedGroups = [...named(forwarderRead).filter((name) => name === forwarderGroup), ...named(runtimeRead)];
  const logGroups = "unreadable" in forwarderRead ? [forwarderGroup, ...listedGroups] : listedGroups;

  const found: string[] = [];
  if (alarms.length > 0) found.push(`${alarms.length} wake alarm(s) under ${prefix}`);
  if (stackExists) found.push(`stack ${stack}`);
  if (bucketExists) found.push(`bucket ${bucket} (${keys.length} object version(s))`);
  if (repoExists) found.push(`repository ${repo}`);
  for (const name of listedGroups) found.push(`log group ${name}`);

  // The one thing this command refuses to delete.
  const kept =
    foreign.length > 0
      ? [
          `bucket ${bucket} — it holds ${foreign.join(", ")}, which no deploy of this version writes. Read it, ` +
            `then \`aws s3 rb s3://${bucket} --force\` if you want it gone`,
        ]
      : [];
  if (!plan.run) {
    return failures.length > 0
      ? gate(`${failures.length} read(s) failed:\n  ${failures.join("\n  ")}`, { found, kept })
      : { ok: true, found, removed: [], kept };
  }

  // ---- The deletions, in the order the dependencies demand. ----

  const removed: string[] = [];
  /** One deletion and its bookkeeping: what got deleted, and what refused to be. */
  const attempt = async (label: string, args: string[]): Promise<boolean> => {
    const result = await aws.write(args);
    if ("done" in result) {
      removed.push(label);
      return true;
    }
    if ("absent" in result) return true; // already gone: the goal state
    failures.push(`${label}: ${result.refused}`);
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
    const asked = await aws.write(["cloudformation", "delete-stack", "--stack-name", stack]);
    if ("refused" in asked) {
      return gate(
        `stack ${stack} refused to delete: ${asked.refused}\n` +
          `  the image and the forwarder package it was built from are untouched, so a retry has what it needs.`,
        { found, removed, kept },
      );
    }
    // THE WAIT DECIDES whether anything below may run, AND whether the stack counts as deleted at all.
    // `delete-stack` returning 0 only means CloudFormation accepted the request: a DELETE_FAILED stack still
    // holds a billing Bedrock runtime and Lambda, and the image and the forwarder zip below are what it was
    // created FROM — deleting those while it stands only makes the operator's retry worse. Recording it as
    // removed before this point printed "deleted: stack X" directly above "did not finish deleting".
    const waited = await aws.write(["cloudformation", "wait", "stack-delete-complete", "--stack-name", stack]);
    if ("refused" in waited) {
      return gate(
        `stack ${stack} did not finish deleting: ${waited.refused}\n` +
          `  its runtime and Lambda are still billing. The image and the forwarder package it was built ` +
          `from are untouched, so a retry has what it needs.`,
        { found, removed, kept },
      );
    }
    removed.push(`stack ${stack}`);

    // AGAIN, NOW. The container served the whole deletion and holds `scheduler:CreateSchedule`, so a wake-up
    // taken in those minutes minted an alarm after the first sweep read the list — an alarm whose target is the
    // Lambda we just deleted, retrying into nothing for weeks.
    const after = await aws.read(
      ["scheduler", "list-schedules", "--name-prefix", prefix, "--output", "json"],
      parseScheduleNames,
    );
    if ("unreadable" in after) {
      failures.push(`re-listing wake alarms under ${prefix}: ${after.unreadable}`);
    } else {
      await sweepAlarms(("ok" in after ? after.ok : []).filter(isMintedAlarm));
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
    return gate(`${failures.length} resource(s) survived:\n  ${failures.join("\n  ")}`, { found, removed, kept });
  }
  return { ok: true, found, removed, kept };
}

/**
 * Empty the bucket, then delete it. The emptying is not optional even for a bucket that was never versioned:
 * `delete-bucket` refuses a non-empty one, and the forwarder's zips are always in there.
 */
async function purgeBucket(
  bucket: string,
  aws: ReturnType<typeof awsCli>,
  attempt: (label: string, args: string[]) => Promise<boolean>,
  failures: string[],
): Promise<void> {
  // RE-READ rather than reusing the inventory: minutes of `stack-delete-complete` sit between the two. And the
  // same three answers as everywhere — a read that failed used to `return` here, leaving the bucket billing
  // while the command reported `nothing left to delete`.
  const listed = await aws.read(
    ["s3api", "list-object-versions", "--bucket", bucket, "--output", "json"],
    parseVersions,
  );
  if ("absent" in listed) return; // gone between the inventory and now: the goal state
  if ("unreadable" in listed) {
    failures.push(`bucket ${bucket}: could not list its objects, so it was left in place (${listed.unreadable})`);
    return;
  }
  // THE SAME RULE ON WHAT IT JUST READ. The decision to delete this bucket was made against the inventory,
  // minutes of `stack-delete-complete` ago, and this listing is the one whose contents actually get deleted.
  // Nothing in the deployment can write here in that window (the template grants the runtime and the forwarder
  // no `s3:*`), so this catches a person or another tool — and a batch delete is not reversible.
  const foreign = [...new Set(listed.ok.map((v) => v.Key).filter((key) => !key.startsWith("forwarder/")))];
  if (foreign.length > 0) {
    failures.push(
      `bucket ${bucket} — ${foreign.join(", ")} appeared in it since the inventory, so it was left in place`,
    );
    return;
  }
  for (let at = 0; at < listed.ok.length; at += DELETE_BATCH) {
    const batch = listed.ok.slice(at, at + DELETE_BATCH).map((v) => ({ Key: v.Key, VersionId: v.VersionId }));
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
