/**
 * A real AgentCore deployment, created and destroyed: `deploy agentcore --run` builds and pushes an
 * image to ECR, then converges a CloudFormation stack holding a Bedrock AgentCore runtime and its
 * execution role.
 *
 * THE FIXTURE DECLARES NO CHANNEL AND NO SCHEDULE, and that is what the topology follows from: with
 * `needsForwarder` false (deploy.ts) there is no forwarder Lambda, no Function URL, no EventBridge
 * rule and no state bucket — the driver skips creating one. The template's forwarder half is proven
 * to PARSE by agentcore.live.test.ts, whose fixture turns it on; what this probe adds is that the
 * minimal stack really converges and really serves. Teardown still sweeps the bucket, because the
 * name is deterministic and a topology change here must not start leaking one.
 *
 * This host shares nothing with the fly/railway probes but the intent. There is NO public URL to curl:
 * AgentCore exposes `POST /invocations` behind `InvokeAgentRuntime`, an IAM-signed AWS API. So the
 * check that the deployment WORKS goes through that API — an `invoke` envelope, not the driver's
 * `checkpoint`; the reason it cannot be a checkpoint is on the assertion itself.
 *
 * TEARDOWN IS THREE PLACES, and the product offers none of them: `delete-stack` is used only to clear
 * a ROLLBACK_COMPLETE husk. The state bucket and the ECR repository are created OUTSIDE the stack on
 * purpose — `plan.ts` says why: so a `delete-stack` "cannot take the agent's memory with it". Correct
 * for an operator, which makes cleanup this probe's own job: stack, then bucket, then repository (with
 * its images).
 *
 * COSTS REAL RESOURCES and is the slowest probe here — a stack create plus delete is minutes.
 *
 * Needs AWS credentials, a model credential, and the `aws` CLI. The IAM policy in the `live`
 * environment must cover FOUR name shapes, because the driver derives each differently from the same
 * directory name (`live-probe-<uuid8>`) — a policy written for the stack pattern alone rejects the
 * bucket, the repository or the runtime, and does it only AFTER the image is built and pushed:
 *
 *   stack       `fastagent-live-probe-*`      (the driver prefixes `fastagent-`)
 *   bucket      `fa-live-probe-*-<account>`   (stateBucketName: `fa-` prefix, account suffix)
 *   repository  `fastagent/live-probe-*`      (a SLASH, not a hyphen)
 *   runtime     `live_probe_*`                (toRuntimeName: underscores, no prefix at all)
 *
 * The directory name carries no `fastagent-` prefix of its own: the driver adds one.
 */
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentcoreName, ingressSessionId, stateBucketName } from "../../src/deploy/agentcore/plan.ts";
import { parseStackOutputs } from "../../src/deploy/agentcore/run.ts";
import { CLI, aws, liveVersion, requireEnv, run } from "./env.ts";

const MODEL = requireEnv("FASTAGENT_LIVE_MODEL", 'the model under test, e.g. "anthropic/claude-sonnet-4-5"');
requireEnv("AWS_ACCESS_KEY_ID", "an AWS key scoped to fastagent-live-probe-* (this probe creates real resources)");
requireEnv("AWS_SECRET_ACCESS_KEY", "the secret for AWS_ACCESS_KEY_ID");
requireEnv("AWS_REGION", "a region where Bedrock AgentCore is available, e.g. us-east-1");

/** The directory basename IS the agent name; every AWS resource derives from it. `live-probe-` keeps
 *  all of them inside the IAM policy's namespace once the driver prefixes `fastagent-`. */
const NAME = agentcoreName(`live-probe-${randomUUID().slice(0, 8)}`);
const STACK = `fastagent-${NAME}`;
const REPO = `fastagent/${NAME}`;

let workspace = "";
let account = "";

beforeAll(async () => {
  const identity = await aws(["sts", "get-caller-identity", "--output", "json"]);
  expect(identity.code, `sts get-caller-identity failed: ${identity.stderr}`).toBe(0);
  account = (JSON.parse(identity.stdout) as { Account: string }).Account;

  // Registered BEFORE anything is created, so the workflow sweep can still find these resources if
  // this process is killed mid-deploy (a job timeout, a cancelled run) and afterAll never runs. The
  // IAM policy forbids account-wide listing, which is what makes a written name the only way.
  if (process.env.RUNNER_TEMP) await appendFile(join(process.env.RUNNER_TEMP, "agentcore-probe-names"), `${NAME}\n`);

  workspace = join(tmpdir(), NAME);
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "persona.md"), "You are terse. Answer in as few words as possible.\n");
  await writeFile(join(workspace, "fastagent.config.mjs"), `export default { model: ${JSON.stringify(MODEL)} };\n`);
  await writeFile(
    join(workspace, "package.json"),
    `${JSON.stringify(
      { name: "live-agentcore-probe", private: true, dependencies: { "@fastagent-sh/fastagent": await liveVersion() } },
      null,
      2,
    )}\n`,
  );
});

afterAll(async () => {
  // Three deletions, each attempted even if an earlier one failed, and every failure reported: what
  // survives a silent teardown here is a Bedrock runtime, a Lambda with a public Function URL, an
  // image in ECR and a bucket holding the model credential seed — all of them billing.
  const errors: unknown[] = [];
  const attempt = async (label: string, args: string[]) => {
    const { code, stderr } = await aws(args);
    // "already gone" is the goal state, not a failure: a probe whose deploy never got that far, or a
    // re-run after a partial teardown, both land here.
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
    // UNREACHED BY THIS FIXTURE: with `needsForwarder` false the driver creates no bucket, so every
    // call below answers NoSuchBucket and the emptying path never runs. It is kept because the name is
    // deterministic and one line in the fixture (a channel, a schedule, `selfSchedule`) turns the
    // bucket on — at which point a teardown that had not been written would leak it silently.
    //
    // What it must do then: the bucket has versioning ON (run.ts enables it), so `s3 rm` does not empty
    // it — it writes a DELETE MARKER per object. Markers are not Versions (they come back under their
    // own key), and a bucket still holding either refuses to go with BucketNotEmpty, which is not one
    // of the tolerated patterns above. Both lists, or the bucket leaks holding the model credential seed.
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

describe("deploy agentcore --run: a real stack, provisioned and destroyed", () => {
  it("converges the stack and the runtime answers a checkpoint", async () => {
    try {
      await run(process.execPath, [CLI, "deploy", "agentcore", "--run"], workspace);
    } catch (error) {
      const e = error as { stderr?: string; stdout?: string };
      throw new Error(`deploy agentcore --run failed for ${STACK}:\n${(e.stderr || e.stdout || "").slice(-4000)}`);
    }

    // The stack's own Outputs, read through the driver's parser: RuntimeArn is what every later call
    // addresses, and the driver gates when it is absent.
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

    // THE assertion that the deployment WORKS, and the only one this host allows: there is no public
    // URL, so it goes through `InvokeAgentRuntime`. The envelope is `invoke` rather than the driver's
    // `checkpoint` because this agent declares no channel — no channel means no forwarder, no forwarder
    // means no FASTAGENT_INGRESS_SECRET (deploy.ts mints it only when one is needed), and without that
    // secret the adapter serves the PUBLIC kind alone: "Undefined = nothing can be trusted, so only the
    // public `invoke` kind is served" (agentcore.ts). A checkpoint here answers 403 from the container.
    // It is also the better assertion: `invoke` runs a real turn, the same thing the fly and railway
    // probes POST for.
    // A real file, NOT /dev/stdout: this CLI writes the response body to the positional argument, and
    // on a runner whose stdout is a pipe Actions owns, opening it answers "No such device or address".
    const out = join(workspace, "invoke-reply.json");
    const payload = join(workspace, "invoke.json");
    await writeFile(
      payload,
      `${JSON.stringify({ kind: "invoke", session: "live-agentcore", text: "Reply with just: ok" })}\n`,
    );
    const reply = await aws([
      "bedrock-agentcore",
      "invoke-agent-runtime",
      "--agent-runtime-arn",
      runtimeArn as string,
      "--runtime-session-id",
      ingressSessionId(NAME),
      "--payload",
      `file://${payload}`,
      "--cli-binary-format",
      "raw-in-base64-out",
      out,
    ]);
    expect(reply.code, `invoke-agent-runtime failed:\n${reply.stderr.slice(-2000)}`).toBe(0);
    const body = await readFile(out, "utf8");

    // The reply is the invoke stream in AgentCore's streaming form — the HTTP channel's SSE, reused
    // wholesale (agentcore.ts). A turn that reached a terminal is what proves the container served.
    expect(body, `the runtime returned no completed terminal:\n${body.slice(0, 600)}`).toContain('"type":"completed"');
  }, 1_800_000);
});
