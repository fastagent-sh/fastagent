/**
 * `destroy agentcore` against a faked AWS CLI.
 *
 * What is worth asserting here is the ORDER and the TOTALITY: the sequence is correct only if it reaches every
 * resource the deploy created, including the three a `delete-stack` leaves behind, and only if a resource that
 * is already gone does not stop it from reaching the rest.
 */
import { describe, expect, it } from "vitest";
import { destroyAgentcoreDeployment } from "../src/deploy/agentcore/destroy.ts";
import type { CliRunner } from "../src/deploy/runner.ts";

const ACCOUNT = "111122223333";

interface FakeAws {
  runner: CliRunner;
  /** Every invocation, as `"<service> <subcommand>"` plus the arguments that identify the target. */
  calls: string[][];
}

/**
 * An AWS CLI that answers the reads and accepts the writes. `replies` overrides one command prefix — the key is
 * matched against the start of the argv, so `"s3api delete-bucket"` catches that call whatever bucket it names.
 */
function fakeAws(replies: Record<string, { code: number; stdout?: string; stderr?: string }> = {}): FakeAws {
  const calls: string[][] = [];
  // A deployment that fully exists: every read answers, so every resource is reported and deleted.
  const defaults: Record<string, { code: number; stdout?: string; stderr?: string }> = {
    "sts get-caller-identity": { code: 0, stdout: JSON.stringify({ Account: ACCOUNT, Arn: "arn:aws:iam::x:root" }) },
    "scheduler list-schedules": { code: 0, stdout: JSON.stringify({ Schedules: [] }) },
    "cloudformation describe-stacks": { code: 0, stdout: JSON.stringify({ Stacks: [{}] }) },
    "s3api list-object-versions": { code: 0, stdout: JSON.stringify({ Versions: [] }) },
    "ecr describe-repositories": { code: 0, stdout: JSON.stringify({ repositories: [{}] }) },
    "logs describe-log-groups": { code: 0, stdout: JSON.stringify(["/aws/lambda/fastagent-probe-forwarder"]) },
  };
  const runner: CliRunner = async (args) => {
    calls.push(args);
    // FAITHFUL ON ONE POINT the real CLI is easy to forget: `--query` renders in whatever `output` the caller's
    // ~/.aws/config sets, so a command that omits `--output json` can hand back plain text. A double that always
    // answered JSON would keep a missing flag invisible.
    if (args.includes("--query") && !args.includes("--output")) {
      return { code: 0, stdout: "first-line\tsecond-line\n", stderr: "" };
    }
    const key = Object.keys({ ...defaults, ...replies })
      .filter((prefix) => args.join(" ").startsWith(prefix))
      .sort((a, b) => b.length - a.length)[0];
    const reply = key ? { ...defaults, ...replies }[key] : undefined;
    return { code: reply?.code ?? 0, stdout: reply?.stdout ?? "", stderr: reply?.stderr ?? "" };
  };
  return { runner, calls };
}

const names = (calls: string[][]) => calls.map((c) => `${c[0]} ${c[1]}`);

describe("destroy agentcore", () => {
  it("reads and deletes nothing without --run", async () => {
    const aws = fakeAws();
    const outcome = await destroyAgentcoreDeployment({ name: "probe", run: false }, aws.runner);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.removed).toEqual([]);
    expect(outcome.found).toEqual([
      "stack fastagent-probe",
      `bucket fa-probe-${ACCOUNT} (0 object version(s))`,
      "repository fastagent/probe",
      "log group /aws/lambda/fastagent-probe-forwarder",
    ]);
    // NO WRITE REACHED AWS. The inventory is the confirmation step for an irreversible command, so it has to be
    // safe to run on a production deployment.
    expect(aws.calls.flat()).not.toContain("delete-stack");
    expect(aws.calls.flat().filter((a) => a.startsWith("delete"))).toEqual([]);
  });

  it("reaches all four resources, wake alarms first and the bucket emptied before it is deleted", async () => {
    const aws = fakeAws({
      "scheduler list-schedules": {
        code: 0,
        stdout: JSON.stringify({ Schedules: [{ Name: "fa-probe-wk-abc" }, { Name: "fa-probe-wk-def" }] }),
      },
      "s3api list-object-versions": {
        code: 0,
        stdout: JSON.stringify({
          Versions: [{ Key: "forwarder/a.zip", VersionId: "v1" }],
          DeleteMarkers: [{ Key: "forwarder/a.zip", VersionId: "v0" }],
        }),
      },
    });
    const outcome = await destroyAgentcoreDeployment({ name: "probe", run: true }, aws.runner);

    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(names(aws.calls)).toEqual([
      "sts get-caller-identity",
      "scheduler list-schedules",
      "cloudformation describe-stacks",
      "s3api list-object-versions",
      "ecr describe-repositories",
      "logs describe-log-groups",
      "cloudformation describe-stacks", // the stack's outputs, for the RUNTIME's log group name
      // ALARMS WHILE THE STACK STANDS: they are minted at runtime into the default Scheduler group, so the
      // stack does not own them, and after the Lambda is gone they retry into nothing for weeks.
      "scheduler delete-schedule",
      "scheduler delete-schedule",
      "cloudformation delete-stack",
      "cloudformation wait",
      "scheduler list-schedules", // again: the container could mint one while the stack was going away
      "s3api list-object-versions",
      // Versions AND delete markers: `delete-bucket` refuses a bucket holding either.
      "s3api delete-objects",
      "s3api delete-bucket",
      "ecr delete-repository",
      "logs delete-log-group",
    ]);
    const deleted = aws.calls.find((c) => c[1] === "delete-objects") as string[];
    expect(JSON.parse(deleted.at(-1) as string).Objects).toEqual([
      { Key: "forwarder/a.zip", VersionId: "v1" },
      { Key: "forwarder/a.zip", VersionId: "v0" },
    ]);
  });

  it("a stack that did NOT finish deleting stops everything, and says what is still billing", async () => {
    // DELETE_FAILED leaves a Bedrock runtime and a Lambda running. Reporting them deleted is the false signal
    // this repo refuses, and deleting the image and the forwarder zip they were built FROM would only make the
    // operator's retry worse.
    const aws = fakeAws({
      "cloudformation wait": {
        code: 255,
        stderr: "Waiter StackDeleteComplete failed: terminal failure state: DELETE_FAILED",
      },
    });
    const outcome = await destroyAgentcoreDeployment({ name: "probe", run: true }, aws.runner);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.gate).toContain("DELETE_FAILED");
    expect(outcome.gate).toContain("still billing");
    expect(names(aws.calls)).not.toContain("s3api delete-bucket");
    expect(names(aws.calls)).not.toContain("ecr delete-repository");
    expect(names(aws.calls)).not.toContain("logs delete-log-group");
  });

  it("deletes the RUNTIME's log group too — the agent's own stdout, which no template owns", async () => {
    // Resolved while the stack still stands, because its name carries the runtime id and only the stack's
    // outputs know that. Structurally identical to the Lambda's group: AWS creates it on first write.
    const runtimeGroup = "/aws/bedrock-agentcore/runtimes/probe-xyz-DEFAULT";
    const aws = fakeAws({
      "cloudformation describe-stacks --stack-name fastagent-probe --query": {
        code: 0,
        stdout: JSON.stringify([
          { OutputKey: "RuntimeArn", OutputValue: "arn:aws:bedrock-agentcore:x:1:runtime/probe-xyz" },
        ]),
      },
      "logs describe-log-groups --log-group-name-prefix /aws/bedrock-agentcore": {
        code: 0,
        stdout: JSON.stringify([runtimeGroup]),
      },
    });
    const outcome = await destroyAgentcoreDeployment({ name: "probe", run: true }, aws.runner);

    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.found).toContain(`log group ${runtimeGroup}`);
    expect(outcome.removed).toContain(`log group ${runtimeGroup}`);
    // AFTER the stack, so a runtime still writing does not re-create it.
    const order = names(aws.calls);
    expect(order.indexOf("cloudformation wait")).toBeLessThan(order.lastIndexOf("logs delete-log-group"));
  });

  it("sweeps a wake alarm minted WHILE the stack was being deleted", async () => {
    // The container serves the whole deletion and holds `scheduler:CreateSchedule`. An alarm taken in those
    // minutes is not in the first listing, and its target is the Lambda this command just deleted.
    let listings = 0;
    const aws = fakeAws({
      "scheduler list-schedules": {
        code: 0,
        stdout: "", // replaced below
      },
    });
    const inner = aws.runner;
    aws.runner = async (args, opts) => {
      if (args[0] === "scheduler" && args[1] === "list-schedules") {
        listings += 1;
        const schedules = listings === 1 ? ["fa-probe-wk-old"] : ["fa-probe-wk-old", "fa-probe-wk-new"];
        await inner(args, opts); // still recorded in calls
        return { code: 0, stdout: JSON.stringify({ Schedules: schedules.map((Name) => ({ Name })) }), stderr: "" };
      }
      return inner(args, opts);
    };
    const outcome = await destroyAgentcoreDeployment({ name: "probe", run: true }, aws.runner);

    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.removed.filter((r) => r.startsWith("wake alarm"))).toEqual([
      "wake alarm fa-probe-wk-old",
      "wake alarm fa-probe-wk-new", // and the old one is not deleted twice
    ]);
  });

  it("finishes a half-deleted deployment: already gone is the goal state, not a failure", async () => {
    // The stack and the repository are gone; the bucket and the log group the deploy created are not. A
    // teardown that stopped at the first miss would leave exactly the two nobody thinks to look for.
    const aws = fakeAws({
      "cloudformation describe-stacks": { code: 254, stderr: "Stack with id fastagent-probe does not exist" },
      "ecr describe-repositories": { code: 254, stderr: "RepositoryNotFoundException: does not exist" },
    });
    const outcome = await destroyAgentcoreDeployment({ name: "probe", run: true }, aws.runner);

    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.removed).not.toContain("stack fastagent-probe");
    // THE POINT: the log group comes last, so a first failure that aborted the run would leave the one
    // resource that holds data and that no template mentions.
    expect(outcome.removed).toContain("log group /aws/lambda/fastagent-probe-forwarder");
  });

  it("keeps a bucket holding anything but the forwarder's zips, and says what is in it", async () => {
    // An older deploy kept `state/snapshot.json.gz` in this bucket. In the account this repo is developed
    // against, two such snapshots were the only remaining copy of two retired agents.
    const aws = fakeAws({
      "s3api list-object-versions": {
        code: 0,
        stdout: JSON.stringify({
          Versions: [
            { Key: "forwarder/a.zip", VersionId: "v1" },
            { Key: "state/snapshot.json.gz", VersionId: "v2" },
          ],
        }),
      },
    });
    const outcome = await destroyAgentcoreDeployment({ name: "probe", run: true }, aws.runner);

    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;
    expect(names(aws.calls)).not.toContain("s3api delete-bucket");
    expect(outcome.kept.join("\n")).toContain("state/snapshot.json.gz");
    // And the rest still goes: keeping the bucket is not a reason to leave a Bedrock runtime billing.
    expect(names(aws.calls)).toContain("cloudformation delete-stack");
    expect(names(aws.calls)).toContain("logs delete-log-group");
  });

  it("a log-group listing it cannot read is a gate, not a bare SyntaxError", async () => {
    // `output = text` in the caller's AWS config is all it takes. The parse is guarded for that reason, and the
    // failure has to reach the operator as one actionable line rather than a stack trace through the CLI.
    const aws = fakeAws({
      "logs describe-log-groups": { code: 0, stdout: "/aws/lambda/fastagent-probe-forwarder\n" },
    });
    const outcome = await destroyAgentcoreDeployment({ name: "probe", run: true }, aws.runner);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.gate).toContain("could not list log groups under /aws/lambda/fastagent-probe-forwarder");
    expect(names(aws.calls)).not.toContain("cloudformation delete-stack");
  });

  it("reports nothing for a deployment that is not there, and claims no deletion", async () => {
    // `aws cloudformation delete-stack` answers 0 for a stack that does not exist, so a teardown that skips the
    // reads reports "deleted: stack X" for something nobody deployed. Observed on a real second `--run`.
    const absent = { code: 254, stderr: "does not exist" };
    const aws = fakeAws({
      "cloudformation describe-stacks": absent,
      "s3api list-object-versions": absent,
      "ecr describe-repositories": absent,
      "logs describe-log-groups": { code: 0, stdout: "[]" },
    });
    const outcome = await destroyAgentcoreDeployment({ name: "probe", run: true }, aws.runner);

    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.found).toEqual([]);
    expect(outcome.removed).toEqual([]);
    expect(aws.calls.flat().filter((a) => a.startsWith("delete"))).toEqual([]);
  });

  it("a deletion that FAILED is reported as a gate, naming what survived", async () => {
    const aws = fakeAws({
      "logs delete-log-group": { code: 254, stderr: "AccessDeniedException: not authorized to DeleteLogGroup" },
    });
    const outcome = await destroyAgentcoreDeployment({ name: "probe", run: true }, aws.runner);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.gate).toContain("log group /aws/lambda/fastagent-probe-forwarder");
    expect(outcome.gate).toContain("AccessDeniedException");
  });

  it("refuses to guess when the wake alarms cannot be listed", async () => {
    // An unreadable list is indistinguishable from an empty one, and the difference is whether something out
    // there is still firing at a Lambda this command is about to delete.
    const aws = fakeAws({
      "scheduler list-schedules": { code: 254, stderr: "AccessDeniedException: not authorized" },
    });
    const outcome = await destroyAgentcoreDeployment({ name: "probe", run: true }, aws.runner);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.gate).toContain("could not list wake alarms under fa-probe-wk-");
    expect(names(aws.calls)).not.toContain("cloudformation delete-stack");
  });
});
