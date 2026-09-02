/**
 * A real AgentCore deployment, created and destroyed: `deploy agentcore --run` builds and pushes an
 * image to ECR, creates the state bucket, and converges a CloudFormation stack holding a Bedrock
 * AgentCore runtime, a forwarder Lambda with a Function URL, its IAM roles, and any schedule rules.
 *
 * This host shares nothing with the fly/railway probes but the intent. There is NO public URL to curl:
 * AgentCore exposes `POST /invocations` behind `InvokeAgentRuntime`, an IAM-signed AWS API. So the
 * check that the deployment WORKS is the one the driver itself makes — a `checkpoint` envelope through
 * `aws bedrock-agentcore invoke-agent-runtime`, read back with the driver's own `parseCheckpointReply`.
 *
 * TEARDOWN IS THREE PLACES, and the product offers none of them: `delete-stack` is used only to clear
 * a ROLLBACK_COMPLETE husk. The state bucket and the ECR repository are created OUTSIDE the stack on
 * purpose — `plan.ts` says why: so a `delete-stack` "cannot take the agent's memory with it". Correct
 * for an operator, which makes cleanup this probe's own job: stack, then bucket (versioned, so every
 * version must go before the bucket will), then repository (with its images).
 *
 * COSTS REAL RESOURCES and is the slowest probe here — a stack create plus delete is minutes.
 *
 * Needs AWS credentials scoped to the `fastagent-live-probe-*` namespace (see the IAM policy in the
 * `live` environment), a model credential, and the `aws` CLI. The directory name carries NO
 * `fastagent-` prefix: the driver adds one to every resource it names.
 */
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentcoreName, ingressSessionId, stateBucketName } from "../../src/deploy/agentcore/plan.ts";
import { parseStackOutputs } from "../../src/deploy/agentcore/run.ts";
import { CLI, liveVersion, requireEnv, run } from "./env.ts";

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

async function aws(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run("aws", args);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

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
    // The bucket has versioning ON (run.ts enables it), so `rb --force` alone leaves delete markers
    // behind and the bucket refuses to go. Object versions must be removed first.
    const bucket = stateBucketName(NAME, account);
    await attempt("s3 rm", ["s3", "rm", `s3://${bucket}`, "--recursive"]);
    const versions = await aws([
      "s3api",
      "list-object-versions",
      "--bucket",
      bucket,
      "--query",
      "{Objects: Versions[].{Key:Key,VersionId:VersionId}}",
      "--output",
      "json",
    ]);
    if (versions.code === 0) {
      const payload = JSON.parse(versions.stdout) as { Objects?: unknown[] | null };
      if (Array.isArray(payload.Objects) && payload.Objects.length > 0) {
        await attempt("s3api delete-objects", [
          "s3api",
          "delete-objects",
          "--bucket",
          bucket,
          "--delete",
          JSON.stringify({ Objects: payload.Objects }),
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
