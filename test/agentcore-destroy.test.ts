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
const REGION = "ap-southeast-1";
/** What AgentCore names the runtime's own log group, which holds the agent's stdout. */
const RUNTIME_PREFIX = "/aws/bedrock-agentcore/runtimes/probe-";
const RUNTIME_GROUP = `${RUNTIME_PREFIX}xyz-DEFAULT`;

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
    "configure get region": { code: 0, stdout: `${REGION}\n` },
    "scheduler list-schedules": { code: 0, stdout: JSON.stringify({ Schedules: [] }) },
    "cloudformation describe-stacks": { code: 0, stdout: JSON.stringify({ Stacks: [{}] }) },
    // EXACT, prefix and all. A wider key here would answer a wider `--log-group-name-prefix` — and the command
    // deletes whatever comes back, which for `/aws/bedrock-agentcore/runtimes/` is every OTHER deployment's
    // group in this account and region.
    [`logs describe-log-groups --log-group-name-prefix ${RUNTIME_PREFIX} `]: {
      code: 0,
      stdout: JSON.stringify([RUNTIME_GROUP]),
    },
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
      `log group ${RUNTIME_GROUP}`,
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
      "configure get", // the region every resource below lives in, reported before anything is touched
      "scheduler list-schedules",
      "cloudformation describe-stacks",
      "s3api list-object-versions",
      "ecr describe-repositories",
      "logs describe-log-groups",
      "logs describe-log-groups", // the RUNTIME's group, named from the definition rather than the stack
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
      "logs delete-log-group", // BOTH: the forwarder's and the runtime's own
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
    // AND IT IS NOT IN `removed`. `delete-stack` returning 0 only means CloudFormation accepted the request;
    // printing "deleted: stack X" directly above "did not finish deleting" is the false signal, twice over,
    // since the runtime it names is still running.
    expect(outcome.removed).not.toContain("stack fastagent-probe");
    expect(names(aws.calls)).not.toContain("s3api delete-bucket");
    expect(names(aws.calls)).not.toContain("ecr delete-repository");
    expect(names(aws.calls)).not.toContain("logs delete-log-group");
  });

  it("deletes the RUNTIME's log group too — the agent's own stdout, which no template owns", async () => {
    // Structurally identical to the Lambda's group: AWS creates it on first write, so no template owns it.
    // Its name comes from the definition (`toRuntimeName`), which is why the stack is not consulted for it.
    const aws = fakeAws();
    const outcome = await destroyAgentcoreDeployment({ name: "probe", run: true }, aws.runner);

    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.found).toContain(`log group ${RUNTIME_GROUP}`);
    expect(outcome.removed).toContain(`log group ${RUNTIME_GROUP}`);
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

  it("an EMPTY listing is an empty list, not a crash: the AWS CLI prints nothing for a paginated no-result", async () => {
    // Not hypothetical. `create-bucket` happens before the upload into it, and a previous destroy that got
    // through `delete-objects` and failed on `delete-bucket` leaves an empty bucket — which is the half-deleted
    // deployment this command exists to finish. An escaping SyntaxError would reach the operator as a Node
    // stack trace: `src/cli.ts` has no catch-all.
    const aws = fakeAws({
      "s3api list-object-versions": { code: 0, stdout: "" },
      "scheduler list-schedules": { code: 0, stdout: "" },
    });
    const outcome = await destroyAgentcoreDeployment({ name: "probe", run: true }, aws.runner);

    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.found).toContain(`bucket fa-probe-${ACCOUNT} (0 object version(s))`);
    expect(outcome.removed).toContain(`bucket fa-probe-${ACCOUNT}`);
    expect(names(aws.calls)).not.toContain("s3api delete-objects"); // nothing in it to delete
  });

  it("output it cannot parse is a gate, not an exception out of the command", async () => {
    const aws = fakeAws({ "s3api list-object-versions": { code: 0, stdout: "<html>proxy error</html>" } });
    const outcome = await destroyAgentcoreDeployment({ name: "probe", run: true }, aws.runner);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.gate).toContain(`could not read the object listing for bucket fa-probe-${ACCOUNT}`);
    expect(names(aws.calls)).not.toContain("cloudformation delete-stack");
  });

  it("asks for the runtime prefix EXACTLY, name transform included", async () => {
    // Everything this listing returns is deleted, so the prefix decides the blast radius: `/…/runtimes/` would
    // take every other deployment's group in this account and region, and that is irreversible. The trailing
    // `-` is what keeps `probe-` off `probe2-…`, and the name is `toRuntimeName`'s, not the directory's.
    const aws = fakeAws();
    await destroyAgentcoreDeployment({ name: "probe", run: false }, aws.runner);
    expect(aws.calls).toContainEqual(
      expect.arrayContaining(["describe-log-groups", "--log-group-name-prefix", RUNTIME_PREFIX]),
    );

    // `probe-1` is not a legal runtime name (`[a-zA-Z][a-zA-Z0-9_]{0,47}`), so the deploy shipped `probe_1` and
    // the group is named after THAT. A prefix built from the directory name would find nothing.
    const dashed = fakeAws();
    await destroyAgentcoreDeployment({ name: "probe-1", run: false }, dashed.runner);
    expect(dashed.calls).toContainEqual(
      expect.arrayContaining(["--log-group-name-prefix", "/aws/bedrock-agentcore/runtimes/probe_1-"]),
    );
  });

  it("finds the runtime's log group with the stack ALREADY gone", async () => {
    // `docs/deploy.md` says an operator's first move is `aws cloudformation delete-stack`, so this is the
    // ordinary case, not an edge one. Reading the group's name out of the stack's `RuntimeArn` meant that after
    // that move the group holding every line the agent printed was silently left behind — while the command
    // reported a clean teardown. The name comes from the definition (`toRuntimeName`), so the stack is not
    // needed to say it.
    const aws = fakeAws({
      "cloudformation describe-stacks": { code: 254, stderr: "Stack with id fastagent-probe does not exist" },
    });
    const outcome = await destroyAgentcoreDeployment({ name: "probe", run: true }, aws.runner);

    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.found).toContain(`log group ${RUNTIME_GROUP}`);
    expect(outcome.removed).toContain(`log group ${RUNTIME_GROUP}`);
    expect(names(aws.calls)).not.toContain("cloudformation delete-stack"); // nothing to delete
  });

  it("reports nothing for a deployment that is not there, and claims no deletion", async () => {
    // `aws cloudformation delete-stack` answers 0 for a stack that does not exist, so a teardown that skips the
    // reads reports "deleted: stack X" for something nobody deployed. Observed on a real second `--run`.
    // The real CLI says so on stderr, and the implementation now READS it — an exit code alone cannot tell
    // "does not exist" from "AccessDeniedException".
    const absent = { code: 254, stderr: "does not exist" };
    const aws = fakeAws({
      "cloudformation describe-stacks": absent,
      "s3api list-object-versions": absent,
      "ecr describe-repositories": absent,
      "logs describe-log-groups": { code: 0, stdout: "[]" },
      [`logs describe-log-groups --log-group-name-prefix ${RUNTIME_PREFIX} `]: { code: 0, stdout: "[]" },
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

  it("a DENIAL on the second bucket read leaves it billing, and SAYS so", async () => {
    // The purge re-reads, because minutes of `stack-delete-complete` sit between the inventory and it. A
    // denial there used to `return` silently: the bucket stayed, `removed` did not mention it, and the CLI
    // printed `nothing left to delete`. The probe's teardown judges leaks by this outcome, so it could not
    // see that shape either — and five orphaned buckets in one account are what it looks like.
    let reads = 0;
    const aws = fakeAws();
    const inner = aws.runner;
    aws.runner = async (args, opts) => {
      if (args[0] === "s3api" && args[1] === "list-object-versions") {
        reads += 1;
        await inner(args, opts);
        return reads === 1
          ? { code: 0, stdout: JSON.stringify({ Versions: [{ Key: "forwarder/a.zip", VersionId: "v1" }] }), stderr: "" }
          : {
              code: 254,
              stdout: "",
              stderr: "An error occurred (AccessDeniedException) when calling ListObjectVersions",
            };
      }
      return inner(args, opts);
    };
    const outcome = await destroyAgentcoreDeployment({ name: "probe", run: true }, aws.runner);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.gate).toContain(`bucket fa-probe-${ACCOUNT}: could not list its objects`);
    expect(names(aws.calls)).not.toContain("s3api delete-bucket");
  });

  it("a failure elsewhere does not hide the bucket it deliberately KEPT", async () => {
    // The kept bucket is this command's only decision of its own. An operator who sees only the survivors does
    // not learn that one bucket was left on purpose, or what is in it.
    const aws = fakeAws({
      "s3api list-object-versions": {
        code: 0,
        stdout: JSON.stringify({ Versions: [{ Key: "state/snapshot.json.gz", VersionId: "v1" }] }),
      },
      "logs delete-log-group": { code: 254, stderr: "AccessDeniedException: not authorized" },
    });
    const outcome = await destroyAgentcoreDeployment({ name: "probe", run: true }, aws.runner);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kept.join("\n")).toContain("state/snapshot.json.gz");
  });

  it("a DENIAL is not an absence: it refuses rather than reporting nothing left to delete", async () => {
    // The one that matters most. `AccessDeniedException`, `ThrottlingException` and `ExpiredToken` all arrive as
    // a non-zero exit code, exactly like `does not exist` — and reading them as absence made this command print
    // `nothing left to delete` over a Bedrock runtime, a Lambda, a repository and a bucket that were all still
    // billing.
    const denied = { code: 254, stderr: "An error occurred (AccessDeniedException) when calling the operation" };
    const aws = fakeAws({ "cloudformation describe-stacks": denied });
    const outcome = await destroyAgentcoreDeployment({ name: "probe", run: true }, aws.runner);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.gate).toContain("could not tell whether stack fastagent-probe exists in ap-southeast-1");
    expect(aws.calls.flat().filter((a) => a.startsWith("delete"))).toEqual([]);

    // Same rule for the other two reads, so the answer cannot depend on which one is denied.
    for (const key of ["s3api list-object-versions", "ecr describe-repositories"]) {
      const one = await destroyAgentcoreDeployment({ name: "probe", run: true }, fakeAws({ [key]: denied }).runner);
      expect(one.ok, `${key} answered a denial and it was read as absence`).toBe(false);
    }
  });

  it("names the REGION it looked in, and refuses when there is none", async () => {
    // Every resource here is regional and none of them says so. A profile pointing somewhere other than the
    // deploy's region answers "nothing in this account", which reads as "already clean".
    const said: string[] = [];
    const aws = fakeAws();
    await destroyAgentcoreDeployment({ name: "probe", run: false }, aws.runner, (m) => said.push(m));
    expect(said.join("\n")).toContain(`account ${ACCOUNT}, region ${REGION}`);

    const noRegion = fakeAws({ "configure get region": { code: 0, stdout: "" } });
    const outcome = await destroyAgentcoreDeployment({ name: "probe", run: true }, noRegion.runner);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.gate).toContain("no AWS region configured");

    // And a missing region fails `get-caller-identity` too, where blaming the credentials sends the operator
    // to fix the wrong thing.
    const stsNoRegion = fakeAws({
      "sts get-caller-identity": {
        code: 253,
        stderr: 'You must specify a region. You can also configure your region by running "aws configure".',
      },
    });
    const classified = await destroyAgentcoreDeployment({ name: "probe", run: true }, stsNoRegion.runner);
    expect(classified.ok).toBe(false);
    if (classified.ok) return;
    expect(classified.gate).toContain("no AWS region configured");
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
