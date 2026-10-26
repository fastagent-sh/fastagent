/**
 * A real AgentCore deployment, created and destroyed: `deploy agentcore --run` builds and pushes an
 * image to ECR, then converges a CloudFormation stack holding a Bedrock AgentCore runtime and its
 * execution role.
 *
 * THE FIXTURE DECLARES NO CHANNEL AND NO SCHEDULE, and that is what the topology follows from: with
 * `topology.forwarder` false (plan.ts agentcoreTopology) there is no forwarder Lambda, no Function URL, no EventBridge
 * rule and no artifact bucket; the driver skips creating one. The template's forwarder half is proven
 * to PARSE by agentcore.live.test.ts, whose fixture turns it on; what this probe adds is that the
 * minimal stack really converges and really serves. Teardown still sweeps the bucket, because the
 * name is deterministic and a topology change here must not start leaking one.
 *
 * This host shares nothing with the fly/railway probes but the intent. There is NO public URL to curl:
 * AgentCore exposes `POST /invocations` behind `InvokeAgentRuntime`, an IAM-signed AWS API, whose one kind is the
 * probe: it opens the deployed agent and says whether it opened. A model turn needs a channel, so it is the wake
 * probe's, whose fixture has one.
 *
 * TEARDOWN, which the product offers none of, is {@link destroyAgentcoreDeployment} — shared with the
 * wake probe, and shared deliberately: it is cleanup code, so a second copy drifts unnoticed until it
 * has been leaking. It sweeps more than this fixture creates (wake alarms, an artifact bucket), which
 * is the point: one line here (a channel, a schedule) turns those on.
 *
 * COSTS REAL RESOURCES and is the slowest probe here — a stack create plus delete is minutes.
 *
 * Needs AWS credentials, a model credential, and the `aws` CLI. The IAM policy in the `live`
 * environment must cover FOUR name shapes, because the driver derives each differently from the same
 * directory name (`live-probe-<uuid8>`) — a policy written for the stack pattern alone rejects the
 * bucket, the repository or the runtime, and does it only AFTER the image is built and pushed:
 *
 *   stack       `fastagent-live-probe-*`      (the driver prefixes `fastagent-`)
 *   bucket      `fa-live-probe-*-<account>`   (deploymentBucketName: `fa-` prefix, account suffix)
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
import { pickStackOutputs } from "../../src/deploy/agentcore/run.ts";
import {
  aws,
  deployAgentcore,
  destroyAgentcoreDeployment,
  installSpec,
  probeAgentcore,
  requireAwsAccount,
  requireEnv,
  stageModelKey,
} from "./env.ts";

const MODEL = requireEnv("FASTAGENT_LIVE_MODEL", 'the model under test, e.g. "anthropic/claude-sonnet-4-5"');

/** The directory basename IS the agent name; every AWS resource derives from it. `live-probe-` keeps
 *  all of them inside the IAM policy's namespace once the driver prefixes `fastagent-`. */
const NAME = agentcoreName(`live-probe-${randomUUID().slice(0, 8)}`);
const STACK = `fastagent-${NAME}`;

let agentDir = "";

beforeAll(async () => {
  // 45 = this probe's own declared budgets, 30 minutes for the deploy plus 15 for teardown.
  // Gate on the credential's remaining lifetime before spending a deploy on it.
  await requireAwsAccount(45);

  // Registered BEFORE anything is created, so the workflow sweep can still find these resources if
  // this process is killed mid-deploy (a job timeout, a cancelled run) and afterAll never runs. The
  // IAM policy forbids account-wide listing, which is what makes a written name the only way.
  if (process.env.RUNNER_TEMP) await appendFile(join(process.env.RUNNER_TEMP, "agentcore-probe-names"), `${NAME}\n`);

  agentDir = join(tmpdir(), NAME);
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "SYSTEM.md"), "You are terse. Answer in as few words as possible.\n");
  await writeFile(join(agentDir, "fastagent.config.ts"), `export default { model: ${JSON.stringify(MODEL)} };\n`);
  await stageModelKey(agentDir, MODEL);
  await writeFile(
    join(agentDir, "package.json"),
    `${JSON.stringify(
      {
        name: "live-agentcore-probe",
        private: true,
        dependencies: { "@fastagent-sh/fastagent": await installSpec(agentDir) },
      },
      null,
      2,
    )}\n`,
  );
});

afterAll(async () => {
  // `finally`, not a catch: the AWS failure still throws, and the temp directory still goes.
  try {
    await destroyAgentcoreDeployment(NAME);
  } finally {
    if (agentDir) await rm(agentDir, { recursive: true, force: true });
  }
}, 900_000);

describe("deploy agentcore --run: a real stack, provisioned and destroyed", () => {
  it("converges the stack, and the deployed agent opens", async () => {
    await deployAgentcore(agentDir, STACK);

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
    const runtimeArn = pickStackOutputs(JSON.parse(outputs.stdout))?.RuntimeArn;
    expect(runtimeArn, `the converged stack has no RuntimeArn output:\n${outputs.stdout.slice(0, 500)}`).toBeTruthy();

    // The definition opened in the container, on its storage, beyond CloudFormation convergence.
    const probe = await probeAgentcore({ runtimeArn: runtimeArn as string, name: NAME, dir: agentDir, label: "probe" });
    expect(probe, `the deployed agent did not open: ${JSON.stringify(probe)}`).toEqual({ ok: true });
  }, 1_800_000);
});
