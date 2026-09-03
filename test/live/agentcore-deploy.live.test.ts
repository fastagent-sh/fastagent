/**
 * A real AgentCore deployment, created and destroyed: `deploy agentcore --run` builds and pushes an
 * image to ECR, then converges a CloudFormation stack holding a Bedrock AgentCore runtime and its
 * execution role.
 *
 * THE FIXTURE DECLARES NO CHANNEL AND NO SCHEDULE, and that is what the topology follows from: with
 * `topology.forwarder` false (plan.ts agentcoreTopology) there is no forwarder Lambda, no Function URL, no EventBridge
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
 * TEARDOWN, which the product offers none of, is {@link destroyAgentcoreDeployment} — shared with the
 * wake probe, and shared deliberately: it is cleanup code, so a second copy drifts unnoticed until it
 * has been leaking. It sweeps more than this fixture creates (wake alarms, a versioned bucket), which
 * is the point: one line here (a channel, a schedule, `selfSchedule`) turns those on.
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
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentcoreName } from "../../src/deploy/agentcore/plan.ts";
import { parseStackOutputs } from "../../src/deploy/agentcore/run.ts";
import { CLI, aws, destroyAgentcoreDeployment, invokeAgentcore, liveVersion, requireEnv, run } from "./env.ts";

const MODEL = requireEnv("FASTAGENT_LIVE_MODEL", 'the model under test, e.g. "anthropic/claude-sonnet-4-5"');
requireEnv("AWS_ACCESS_KEY_ID", "an AWS key scoped to fastagent-live-probe-* (this probe creates real resources)");
requireEnv("AWS_SECRET_ACCESS_KEY", "the secret for AWS_ACCESS_KEY_ID");
requireEnv("AWS_REGION", "a region where Bedrock AgentCore is available, e.g. us-east-1");

/** The directory basename IS the agent name; every AWS resource derives from it. `live-probe-` keeps
 *  all of them inside the IAM policy's namespace once the driver prefixes `fastagent-`. */
const NAME = agentcoreName(`live-probe-${randomUUID().slice(0, 8)}`);
const STACK = `fastagent-${NAME}`;

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
  // `finally`, not a catch: the AWS failure still throws, and the temp directory still goes.
  try {
    await destroyAgentcoreDeployment(NAME, account);
  } finally {
    if (workspace) await rm(workspace, { recursive: true, force: true });
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
    const body = await invokeAgentcore({
      runtimeArn: runtimeArn as string,
      name: NAME,
      session: "live-agentcore",
      text: "Reply with just: ok",
      dir: workspace,
      label: "invoke",
    });

    // The reply is the invoke stream in AgentCore's streaming form — the HTTP channel's SSE, reused
    // wholesale (agentcore.ts). A turn that reached a terminal is what proves the container served.
    expect(body, `the runtime returned no completed terminal:\n${body.slice(0, 600)}`).toContain('"type":"completed"');
  }, 1_800_000);
});
